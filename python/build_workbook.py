#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""hardware-quote · 生成两工作表报价工作簿（「报价BOM」+「报价底稿」）。

用法（可从任意 cwd 调用，资源路径由 __file__ 定位）：
    python build_workbook.py --plan plan.json [--out out.xlsx] [--report report.json]

设计要点
--------
1. 模板扩行：openpyxl 的 insert_rows 不复制合并单元格/公式，所以先用标准库
   zipfile+ElementTree 做旧版 prepare_template.py 等价的 OOXML 扩行，再交给
   openpyxl 填内容与样式。
2. 布局：全部行号由 JS 侧 layoutFor(配件条数) 算出（plan.layout），Python 只按
   plan 写单元格，保证 JS 测试与 Excel 实际行号一致。
3. 校验：保存后用 openpyxl 重新打开产出文件，用本文件内置的迷你公式求值器
   真读回每个公式单元格求值，扫描 #REF!/#DIV/0!/#VALUE!/#NAME? 等错误，
   并核对关键行号/公式/超链接/图片/打印设置，结果写入 report.json。
   本机无 LibreOffice/Excel，因此不声称完成 Excel 重算，只做静态求值校验；
   workbook.xml 设置 calcPr fullCalcOnLoad=1 让 Excel 打开时重算。
"""
import argparse
import copy
import json
import math
import re
import sys
import traceback
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.drawing.image import Image as XLImage
from openpyxl.drawing.spreadsheet_drawing import AnchorMarker, OneCellAnchor
from openpyxl.drawing.xdr import XDRPositiveSize2D
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import column_index_from_string, get_column_letter
from openpyxl.utils.units import pixels_to_EMU
from openpyxl.workbook.properties import CalcProperties
from openpyxl.worksheet.hyperlink import Hyperlink
from openpyxl.worksheet.properties import PageSetupProperties
from PIL import Image as PILImage

FRONT = '报价BOM'
BOTTOM = '报价底稿'
PLUGIN_ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = PLUGIN_ROOT / 'skill' / 'assets' / '对外报价BOM表.xlsx'

# Microsoft YaHei 在 Windows Excel 上稳定显示中文；数字格式与旧版一致。
FONT = Font(name='Microsoft YaHei', size=10)
FONT_BAND = Font(name='Microsoft YaHei', size=10, bold=True, color='FF164E63')
FONT_HEADER = Font(name='Microsoft YaHei', size=10, bold=True, color='FFFFFFFF')
FONT_LINK = Font(name='Microsoft YaHei', size=10, color='FF1565C0')
FONT_STATUS_OK = Font(name='Microsoft YaHei', size=10, color='FF475569')
FONT_STATUS_BAD = Font(name='Microsoft YaHei', size=10, color='FFB91C1C')
FILL_BAND = PatternFill('solid', fgColor='FFE8EEF2')
FILL_HEADER = PatternFill('solid', fgColor='FF164E63')
FILL_INPUT = PatternFill('solid', fgColor='FFFFF5CC')
ALIGN_CENTER = Alignment(horizontal='center', vertical='center', wrap_text=True)
ALIGN_LEFT = Alignment(horizontal='left', vertical='center')
ALIGN_RIGHT = Alignment(horizontal='right', vertical='center')

BOTTOM_WIDTHS = {'A': 24, 'B': 24, 'C': 10, 'D': 13, 'E': 13, 'F': 16, 'G': 14, 'H': 22, 'I': 21}

ERROR_CODES = ('#REF!', '#DIV/0!', '#VALUE!', '#NAME?', '#NUM!', '#NULL!', '#SPILL!', '#CALC!')


# ────────────────────────────────────────────────────────────── 模板扩行
NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
RELNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
ET.register_namespace('', NS)
ET.register_namespace('r', RELNS)
ET.register_namespace('mc', 'http://schemas.openxmlformats.org/markup-compatibility/2006')
ET.register_namespace('x14ac', 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac')
ET.register_namespace('xr', 'http://schemas.openxmlformats.org/officeDocument/2014/revision')
ET.register_namespace('xr2', 'http://schemas.openxmlformats.org/officeDocument/2015/revision2')
ET.register_namespace('xr3', 'http://schemas.openxmlformats.org/officeDocument/2016/revision3')


def q(tag):
    return '{%s}%s' % (NS, tag)


def expand_template(source, target, count):
    """与旧版 prepare_template.py 等价：插入配件行与未税报价行，保留原样式。

    mapped(n) = n + (n>=16 ? extra : 0) + (n>=37 ? 1 : 0)
    extra = max(2, 配件条数) - 2
    """
    extra = max(2, count) - 2

    def mapped(n):
        return n + (extra if n >= 16 else 0) + (1 if n >= 37 else 0)

    def refs(text):
        return re.sub(r'(\$?[A-Z]{1,3}\$?)(\d+)', lambda m: m.group(1) + str(mapped(int(m.group(2)))), text)

    with zipfile.ZipFile(source) as zin:
        data = {name: zin.read(name) for name in zin.namelist()}
    root = ET.fromstring(data['xl/worksheets/sheet1.xml'])
    # mc:Ignorable 引用 x14ac/xr/xr2/xr3 前缀；ElementTree 序列化后这些声明可能丢失，
    # 直接去掉该属性（不影响 Excel 读取），避免产出“需要修复”的文件。
    root.attrib.pop('{http://schemas.openxmlformats.org/markup-compatibility/2006}Ignorable', None)
    sd = root.find(q('sheetData'))
    if sd is None:
        raise ValueError('模板缺少 sheetData，无法扩行。')
    originals = {int(row.get('r')): copy.deepcopy(row) for row in sd}
    if 15 not in originals or 37 not in originals:
        raise ValueError('不匹配的BOM模板：缺少配件或税金行。')
    for row in sd:
        row.set('r', str(mapped(int(row.get('r')))))
        for c in row:
            if 'r' in c.attrib:
                c.set('r', refs(c.get('r')))
            f = c.find(q('f'))
            if f is not None:
                if f.text:
                    f.text = refs(f.text)
                if 'ref' in f.attrib:
                    f.set('ref', refs(f.get('ref')))
    for n in range(extra):
        row = copy.deepcopy(originals[15])
        new_r = 16 + n
        row.set('r', str(new_r))
        for c in row:
            c.set('r', re.sub(r'\d+$', str(new_r), c.get('r')))
            for child in list(c):
                c.remove(child)
            c.attrib.pop('t', None)
        sd.append(row)
    inserted = 37 + extra
    row = copy.deepcopy(originals[37])
    row.set('r', str(inserted))
    for c in row:
        c.set('r', re.sub(r'\d+$', str(inserted), c.get('r')))
        for child in list(c):
            c.remove(child)
        c.attrib.pop('t', None)
    sd.append(row)
    sd[:] = sorted(sd, key=lambda row: int(row.get('r')))
    merges = root.find(q('mergeCells'))
    if merges is not None:
        for merge in list(merges):
            old = merge.get('ref')
            if old == 'I14:I15':
                merges.remove(merge)
                continue
            merge.set('ref', 'A13:A%d' % (15 + extra) if old == 'A13:A15' else refs(old))
        for ref in ('D%d:F%d' % (inserted, inserted), 'G%d:I%d' % (inserted, inserted)):
            ET.SubElement(merges, q('mergeCell'), {'ref': ref})
        merges.set('count', str(len(merges)))
    subtotal = next(c for row in sd for c in row if c.get('r') == 'H%d' % (16 + extra))
    f = subtotal.find(q('f'))
    if f is None:
        f = ET.SubElement(subtotal, q('f'))
    f.text = 'SUM(H14:H%d)' % (15 + extra)
    dim = root.find(q('dimension'))
    if dim is not None:
        dim.set('ref', refs(dim.get('ref')))
    data['xl/worksheets/sheet1.xml'] = ET.tostring(root, encoding='utf-8', xml_declaration=True)
    wb = ET.fromstring(data['xl/workbook.xml'])
    sheets = wb.find(q('sheets'))
    if sheets is None or len(sheets) != 1:
        raise ValueError('BOM模板必须只有一个工作表。')
    sheets[0].set('name', FRONT)
    names = wb.find(q('definedNames'))
    if names is not None:
        for name in list(names):
            if name.get('name') == '_xlnm.Print_Area':
                names.remove(name)
        for name in names:
            if name.text:
                name.text = refs(name.text).replace('Sheet1', FRONT)
    if 'xl/calcChain.xml' in data:
        chain = ET.fromstring(data['xl/calcChain.xml'])
        for c in chain:
            if 'r' in c.attrib:
                c.set('r', refs(c.get('r')))
        data['xl/calcChain.xml'] = ET.tostring(chain, encoding='utf-8', xml_declaration=True)
    Path(target).parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(str(target), 'w', zipfile.ZIP_DEFLATED) as zout:
        for name, content in data.items():
            zout.writestr(name, content)


# ────────────────────────────────────────────────────────────── 单元格辅助
def iter_cells(ws, ref):
    value = ws[ref]
    if isinstance(value, tuple):
        for row in value:
            if isinstance(row, tuple):
                for cell in row:
                    yield cell
            else:
                yield row
    else:
        yield value


def numfmt(ws, ref, fmt):
    for cell in iter_cells(ws, ref):
        cell.number_format = fmt


def put(ws, row, col, value, fmt=None, align=None, wrap=False):
    cell = ws.cell(row=row, column=col)
    cell.value = value
    cell.font = FONT
    cell.alignment = Alignment(horizontal=align, vertical='center', wrap_text=wrap)
    if fmt:
        cell.number_format = fmt
    return cell


def text(ws, addr, value):
    s = '' if value is None else str(value)
    ws[addr].value = "'" + s if s.startswith('=') else s


def number(ws, addr, value):
    ws[addr].value = value


def formula(ws, addr, expr):
    ws[addr].value = expr


def set_value(ws, addr, value):
    """旧版 set()：数字直接写；null 写 =NA()；其余写安全文本。"""
    if isinstance(value, bool):
        ws[addr].value = value
    elif isinstance(value, (int, float)) and math.isfinite(value):
        ws[addr].value = value
    elif value is None:
        ws[addr].value = '=NA()'
    else:
        text(ws, addr, value)


def merge(ws, ref):
    ws.merge_cells(ref)


def style_range(ws, ref, fill=None, font=None, alignment=None):
    for cell in iter_cells(ws, ref):
        if fill is not None:
            cell.fill = fill
        if font is not None:
            cell.font = font
        if alignment is not None:
            cell.alignment = alignment


def add_link(ws, addr, target=None, location=None, display=None):
    cell = ws[addr]
    cell.hyperlink = Hyperlink(ref=cell.coordinate, target=target, location=location, display=display)
    cell.font = FONT_LINK


URL_RE = re.compile(r'https?://[^\s\u3000-\u9fff，。；）]+')


def band(ws, row, title):
    merge(ws, 'A%d:I%d' % (row, row))
    text(ws, 'A%d' % row, title)
    style_range(ws, 'A%d:I%d' % (row, row), fill=FILL_BAND, font=FONT_BAND,
                alignment=Alignment(vertical='center', wrap_text=True))
    ws.row_dimensions[row].height = 25


def header(ws, row, values):
    for i, value in enumerate(values):
        put(ws, row, i + 1, value, align='center', wrap=True)
    style_range(ws, 'A%d:I%d' % (row, row), fill=FILL_HEADER, font=FONT_HEADER,
                alignment=ALIGN_CENTER)
    ws.row_dimensions[row].height = 31


def note(ws, row, message):
    merge(ws, 'A%d:I%d' % (row, row))
    text(ws, 'A%d' % row, message)
    style_range(ws, 'A%d:I%d' % (row, row), font=FONT,
                alignment=Alignment(vertical='center', wrap_text=True))
    length = len(str(message))
    ws.row_dimensions[row].height = max(27, min(90, math.ceil(length / 85) * 18 + 12))
    url = URL_RE.search(str(message))
    if url:
        add_link(ws, 'A%d' % row, target=url.group(0), display=str(message))


def excel_date(value):
    from datetime import date
    y, m, d = (int(x) for x in str(value).split('-'))
    return (date(y, m, d) - date(1899, 12, 30)).days


def fmt_dimensions(d):
    if not d:
        return ''
    return '%s×%s×%s cm' % (d['length'], d['width'], d['height'])


def safe_text(value):
    s = '' if value is None else str(value)
    return "'" + s if s.startswith('=') else s


# ────────────────────────────────────────────────────────────── 公式静态求值
class EvalError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


TOKEN_RE = re.compile(r"""
    \s*
    (?:
        (?P<num>\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)
      | (?P<str>"(?:[^"]|"")*")
      | (?P<sheet>'(?:[^']|'')+'!|[A-Za-z_\u4e00-\u9fff][\w.\u4e00-\u9fff]*!)
      | (?P<ref>\$?[A-Za-z]{1,3}\$?\d+)
      | (?P<func>[A-Za-z_][\w.]*)\s*\(
      | (?P<op><=|>=|<>|[-+*/^&%=<>,():])
      | (?P<word>[A-Za-z_][\w.]*)
    )
""", re.VERBOSE)


def tokenize(formula):
    tokens, pos = [], 0
    length = len(formula)
    while pos < length:
        m = TOKEN_RE.match(formula, pos)
        if not m or m.end() == pos:
            raise EvalError('#VALUE!')
        pos = m.end()
        kind = m.lastgroup
        tokens.append((kind, m.group(kind)))
        if pos >= length:
            break
    return tokens


def parse_cell_ref(ref):
    m = re.match(r'\$?([A-Za-z]{1,3})\$?(\d+)$', ref)
    if not m:
        raise EvalError('#REF!')
    return int(m.group(2)), column_index_from_string(m.group(1).upper())


class FormulaParser:
    def __init__(self, tokens):
        self.tokens = tokens
        self.i = 0

    def peek(self):
        return self.tokens[self.i] if self.i < len(self.tokens) else (None, None)

    def take(self):
        if self.i >= len(self.tokens):
            raise EvalError('#VALUE!')
        token = self.tokens[self.i]
        self.i += 1
        return token

    def parse(self):
        node = self.compare()
        if self.i != len(self.tokens):
            raise EvalError('#VALUE!')
        return node

    def compare(self):
        node = self.concat()
        while True:
            kind, value = self.peek()
            if kind == 'op' and value in ('=', '<', '>', '<=', '>=', '<>-') or (kind == 'op' and value in ('<=', '>=', '<>', '=', '<', '>')):
                self.i += 1
                node = ('bin', value, node, self.concat())
            else:
                return node

    def concat(self):
        node = self.add()
        while self.peek() == ('op', '&'):
            self.i += 1
            node = ('bin', '&', node, self.add())
        return node

    def add(self):
        node = self.mul()
        while self.peek()[0] == 'op' and self.peek()[1] in ('+', '-'):
            op = self.take()[1]
            node = ('bin', op, node, self.mul())
        return node

    def mul(self):
        node = self.power()
        while self.peek()[0] == 'op' and self.peek()[1] in ('*', '/'):
            op = self.take()[1]
            node = ('bin', op, node, self.power())
        return node

    def power(self):
        node = self.unary()
        while self.peek() == ('op', '^'):
            self.i += 1
            node = ('bin', '^', node, self.unary())
        return node

    def unary(self):
        kind, value = self.peek()
        if kind == 'op' and value in ('+', '-'):
            self.i += 1
            return ('neg', self.unary()) if value == '-' else self.unary()
        node = self.primary()
        while self.peek() == ('op', '%'):
            self.i += 1
            node = ('pct', node)
        return node

    def primary(self):
        kind, value = self.peek()
        if kind == 'num':
            self.i += 1
            return ('num', float(value))
        if kind == 'str':
            self.i += 1
            return ('str', value[1:-1].replace('""', '"'))
        if kind == 'sheet':
            self.i += 1
            return self.ref_node(unquote_sheet(value))
        if kind == 'ref':
            return self.ref_node(None)
        if kind == 'func':
            self.i += 1
            name = value.upper()
            args = []
            if self.peek() == ('op', ')'):
                self.i += 1
                return ('func', name, args)
            while True:
                args.append(self.compare())
                kind2, value2 = self.take()
                if kind2 == 'op' and value2 == ')':
                    break
                if not (kind2 == 'op' and value2 == ','):
                    raise EvalError('#VALUE!')
            return ('func', name, args)
        if kind == 'word':
            self.i += 1
            upper = value.upper()
            if upper == 'TRUE':
                return ('bool', True)
            if upper == 'FALSE':
                return ('bool', False)
            return ('name', value)
        if kind == 'op' and value == '(':
            self.i += 1
            node = self.compare()
            if self.take() != ('op', ')'):
                raise EvalError('#VALUE!')
            return node
        raise EvalError('#VALUE!')

    def ref_node(self, sheet):
        kind, value = self.take()
        if kind != 'ref':
            raise EvalError('#REF!')
        row, col = parse_cell_ref(value)
        if self.peek() == ('op', ':'):
            self.i += 1
            kind2, value2 = self.take()
            if kind2 != 'ref':
                raise EvalError('#REF!')
            row2, col2 = parse_cell_ref(value2)
            return ('range', sheet, row, col, row2, col2)
        return ('ref', sheet, row, col)


def unquote_sheet(token):
    name = token[:-1]
    if name.startswith("'") and name.endswith("'"):
        name = name[1:-1].replace("''", "'")
    return name


def truth(value):
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    if isinstance(value, (int, float)):
        return value != 0
    raise EvalError('#VALUE!')


def to_number(value):
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    raise EvalError('#VALUE!')


class WorkbookEvaluator:
    """对 openpyxl 读回的工作簿做静态公式求值（不依赖 Excel/LibreOffice）。"""

    def __init__(self, workbook):
        self.wb = workbook
        self.cache = {}
        self.ast = {}
        self.visiting = set()

    def value(self, sheet, row, col):
        key = (sheet, row, col)
        if key in self.cache:
            return self.cache[key]
        if key in self.visiting:
            raise EvalError('#REF!')
        cell = self.wb[sheet].cell(row=row, column=col)
        raw = cell.value
        if isinstance(raw, str) and raw.startswith('='):
            body = raw[1:]
            if body not in self.ast:
                self.ast[body] = FormulaParser(tokenize(body)).parse()
            self.visiting.add(key)
            try:
                result = self._ev(self.ast[body], sheet)
            finally:
                self.visiting.discard(key)
            self.cache[key] = result
            return result
        self.cache[key] = raw
        return raw

    def range_values(self, node, sheet):
        _, sheetname, r1, c1, r2, c2 = node
        sheetname = sheetname or sheet
        values = []
        for r in range(min(r1, r2), max(r1, r2) + 1):
            for c in range(min(c1, c2), max(c1, c2) + 1):
                values.append(self.value(sheetname, r, c))
        return values

    def _arg_values(self, node, sheet):
        if node[0] == 'range':
            return self.range_values(node, sheet)
        return [self._ev(node, sheet)]

    def _ev(self, node, sheet):
        kind = node[0]
        if kind == 'num':
            return node[1]
        if kind == 'str':
            return node[1]
        if kind == 'bool':
            return node[1]
        if kind == 'ref':
            return self.value(node[1] or sheet, node[2], node[3])
        if kind == 'range':
            values = self.range_values(node, sheet)
            if len(values) == 1:
                return values[0]
            return values
        if kind == 'neg':
            return -to_number(self._ev(node[1], sheet))
        if kind == 'pct':
            return to_number(self._ev(node[1], sheet)) / 100.0
        if kind == 'name':
            raise EvalError('#NAME?')
        if kind == 'bin':
            op = node[1]
            left = self._ev(node[2], sheet)
            right = self._ev(node[3], sheet)
            if op == '&':
                return concat_text(left, right)
            if op in ('=', '<', '>', '<=', '>=', '<>'):
                return compare(op, left, right)
            a, b = to_number(left), to_number(right)
            if op == '+':
                return a + b
            if op == '-':
                return a - b
            if op == '*':
                return a * b
            if op == '/':
                if b == 0:
                    raise EvalError('#DIV/0!')
                return a / b
            if op == '^':
                return a ** b
            raise EvalError('#VALUE!')
        if kind == 'func':
            return self._call(node[1], node[2], sheet)
        raise EvalError('#VALUE!')

    def _call(self, name, args, sheet):
        if name == 'IF':
            if len(args) < 2:
                raise EvalError('#VALUE!')
            cond = truth(self._ev(args[0], sheet))
            if cond:
                return self._ev(args[1], sheet)
            return self._ev(args[2], sheet) if len(args) > 2 else False
        if name in ('AND', 'OR'):
            want = name == 'OR'
            result = not want
            for arg in args:
                current = truth(self._ev(arg, sheet))
                if want and current:
                    return True
                if not want and not current:
                    return False
                result = current
            return result
        if name == 'NOT':
            return not truth(self._ev(args[0], sheet)) if args else EvalError('#VALUE!')
        if name == 'NA':
            raise EvalError('#N/A')
        if name == 'ISNUMBER':
            if not args:
                raise EvalError('#VALUE!')
            try:
                value = self._ev(args[0], sheet)
            except EvalError:
                return False
            return isinstance(value, (int, float)) and not isinstance(value, bool)
        if name == 'IFERROR':
            try:
                return self._ev(args[0], sheet)
            except EvalError:
                return self._ev(args[1], sheet) if len(args) > 1 else ''
        if name == 'ABS':
            return abs(to_number(self._ev(args[0], sheet)))
        if name == 'ROUND':
            value = to_number(self._ev(args[0], sheet))
            digits = int(to_number(self._ev(args[1], sheet))) if len(args) > 1 else 0
            factor = 10.0 ** digits
            return math.floor(abs(value) * factor + 0.5) / factor * (1 if value >= 0 else -1)
        if name in ('SUM', 'AVERAGE', 'COUNT', 'MAX', 'MIN'):
            numbers = []
            for arg in args:
                for value in self._arg_values(arg, sheet):
                    if isinstance(value, bool) or value is None:
                        continue
                    if isinstance(value, (int, float)):
                        numbers.append(float(value))
            if name == 'SUM':
                return sum(numbers)
            if name == 'COUNT':
                return float(len(numbers))
            if name == 'AVERAGE':
                if not numbers:
                    raise EvalError('#DIV/0!')
                return sum(numbers) / len(numbers)
            if name == 'MAX':
                return max(numbers) if numbers else 0.0
            return min(numbers) if numbers else 0.0
        raise EvalError('#NAME?')


def concat_text(left, right):
    def as_text(value):
        if value is None:
            return ''
        if isinstance(value, bool):
            return 'TRUE' if value else 'FALSE'
        if isinstance(value, (int, float)):
            return str(int(value)) if float(value).is_integer() else repr(float(value))
        return str(value)
    return as_text(left) + as_text(right)


def compare(op, left, right):
    if isinstance(left, str) or isinstance(right, str):
        a = '' if left is None else left
        b = '' if right is None else right
        if not (isinstance(a, str) and isinstance(b, str)):
            raise EvalError('#VALUE!')
        a, b = a.lower(), b.lower()
    else:
        a, b = to_number(left), to_number(right)
    if op == '=':
        return a == b
    if op == '<>':
        return a != b
    if op == '<':
        return a < b
    if op == '>':
        return a > b
    if op == '<=':
        return a <= b
    return a >= b


# ────────────────────────────────────────────────────────────── 报价底稿
def write_bottom(ws, plan):
    calc = plan['calc']
    inp = plan['input']
    layout = plan['layout']
    ready = bool(calc.get('ready'))
    draft = not ready
    version = plan['meta']['pluginVersion']
    issues = calc.get('issues') or []
    weights = calc.get('weights') or {}

    ws.sheet_view.showGridLines = False
    for col, width in BOTTOM_WIDTHS.items():
        ws.column_dimensions[col].width = width

    c = ws['A1']
    c.value = '报价底稿'
    c.font = Font(name='Microsoft YaHei', size=15, bold=True, color='FF164E63')
    c.alignment = Alignment(vertical='center')
    ws.row_dimensions[1].height = 33

    merge(ws, 'A2:I2')
    text(ws, 'A2', '%s  %s  报价日期：%s  规则版本：%s' % (
        calc['product'].get('name', ''), calc['product'].get('sku', ''),
        calc['product'].get('date', ''), version))
    style_range(ws, 'A2:I2', font=FONT, alignment=Alignment(vertical='center', wrap_text=True))
    ws.row_dimensions[2].height = 24

    blocking = [x for x in issues if x.get('severity') == 'blocking']
    if ready:
        status = ('含估算或提醒，请检查下方依据。'
                  if (calc.get('assumptions') or issues) else '已按输入核算，参考价格见下方。')
    else:
        status = '待核价：' + '；'.join(x.get('message', '') for x in blocking)
    merge(ws, 'A3:I3')
    text(ws, 'A3', status)
    style_range(ws, 'A3:I3', font=FONT if ready else FONT_STATUS_BAD,
                alignment=Alignment(vertical='center', wrap_text=True))
    if ready:
        style_range(ws, 'A3:I3', font=FONT if not issues else FONT_STATUS_OK)
    ws.row_dimensions[3].height = 27 if ready else min(160, 35 + len(issues) * 18)

    for i, label in enumerate(['核算参数', '值', '单位', '依据']):
        put(ws, 4, i + 1, label, align='center', wrap=True)
    style_range(ws, 'A4:D4', fill=FILL_HEADER, font=FONT_HEADER, alignment=ALIGN_CENTER)
    ws.row_dimensions[4].height = 28

    carton = calc['product'].get('cartonDimensions')
    parameters = [
        ('铁单价', calc['rates']['metal'], '元/kg', '用户约定'),
        ('木单价', calc['rates']['wood'], '元/kg', '用户约定'),
        ('喷涂单价', calc['rates']['coating'], '元/kg', '用户约定'),
        ('纸箱平方单价', calc['rates']['carton'], '元/m²', '用户约定'),
        ('税金参数', calc['rates']['tax'], '比例', '沿用原表'),
        ('含税净利率目标', calc['rates']['netMargin'], '比例', '利润÷含税报价'),
        ('管理费/利润', calc['rates']['managementToProfit'], '比例', '按利润金额比例'),
        ('采购产品数量', calc['order']['quantity'], '件', '本次采购口径'),
        ('每箱产品数', calc['order']['unitsPerCarton'], '件/箱', '本次装箱口径'),
        ('外箱长', carton['length'] if carton else None, 'cm', '用户提供'),
        ('外箱宽', carton['width'] if carton else None, 'cm', '用户提供'),
        ('外箱高', carton['height'] if carton else None, 'cm', '用户提供'),
        ('组装净重', weights.get('net'), 'kg', '用户确认，含轮子等必需配件'),
        ('主料木材重量', weights.get('wood'), 'kg',
         '纯金属，木重为0' if calc['product'].get('material') == 'metal'
         else ('按实际木件体积估算' if calc.get('woodPieces') else '分重/材质分配')),
        ('主料金属重量', weights.get('metal'), 'kg', '主料本体重量减木重'),
        ('毛重', weights.get('gross'), 'kg', '整件＋包材＋非组装附带件'),
        ('组装配件重量', weights.get('accessories'), 'kg', '拆分主料时扣除，净重保留'),
        ('包材重量', weights.get('packaging'), 'kg', '仅从毛重扣除'),
        ('开料、焊接人工单价', plan['meta']['processingRatePerKg'], '元/kg',
         '本体金属重量×3元/kg（加工成本）'),
        ('主料本体重量', weights.get('body'), 'kg', '组装净重减必需配件'),
        ('非组装附带件重量', weights.get('extras'), 'kg', '不计净重，随货成本仍计入'),
    ]
    net_origin = weights.get('netOrigin')
    for index, row_values in enumerate(parameters):
        row = 5 + index
        for col in range(4):
            value = row_values[col]
            if col == 1:
                if value is None:
                    if row in (20, 21, 22) and net_origin != 'gross':
                        text(ws, '%s%d' % (get_column_letter(col + 1), row), '')
                    else:
                        set_value(ws, '%s%d' % (get_column_letter(col + 1), row), None)
                else:
                    set_value(ws, '%s%d' % (get_column_letter(col + 1), row), value)
            else:
                set_value(ws, '%s%d' % (get_column_letter(col + 1), row), value)
        ws['B%d' % row].fill = FILL_INPUT
        ws.row_dimensions[row].height = 24
    for row in range(5, 26):
        for col in range(1, 5):
            cell = ws.cell(row=row, column=col)
            cell.font = FONT
            cell.alignment = Alignment(horizontal='left' if col == 1 else 'right', vertical='center')

    for row in (9, 10, 11):
        ws['B%d' % row].number_format = '0.0%'
    numfmt(ws, 'B5:B8', '0.00')
    numfmt(ws, 'B14:B22', '0.000')
    numfmt(ws, 'B23', '0.00')
    numfmt(ws, 'B24:B25', '0.000')

    merge(ws, 'F4:I4')
    text(ws, 'F4', '重量口径与报价')
    style_range(ws, 'F4:I4', fill=FILL_HEADER, font=FONT_HEADER, alignment=ALIGN_CENTER)
    for row, message in ((5, '净重＝组装整件，含全部必需配件。'),
                         (6, '毛重＝整件＋包材＋非组装附带件。'),
                         (7, '主料重量＝组装净重－组装配件重量。'),
                         (8, '开料、焊接人工＝本体金属重量×3元/kg（加工成本）'),
                         (13, '参考单价按下方采购需求匹配档位。'),
                         (14, '改变数量后，核对价格档位和重量。')):
        merge(ws, 'F%d:I%d' % (row, row))
        text(ws, 'F%d' % row, message)
        style_range(ws, 'F%d:I%d' % (row, row), font=FONT,
                    alignment=Alignment(vertical='center', wrap_text=True))
        ws.row_dimensions[row].height = 30
    for row, label, ref in ((9, '未税报价', 'G%d' % layout['beforeTax']),
                            (10, '含税报价', 'G%d' % layout['afterTax']),
                            (11, '实际含税净利率', 'L%d' % layout['afterTax'])):
        merge(ws, 'F%d:G%d' % (row, row))
        text(ws, 'F%d' % row, label)
        style_range(ws, 'F%d:G%d' % (row, row), font=FONT,
                    alignment=Alignment(vertical='center', wrap_text=True))
        merge(ws, 'H%d:I%d' % (row, row))
        formula(ws, 'H%d' % row, "='%s'!%s" % (FRONT, ref))
        numfmt(ws, 'H%d:I%d' % (row, row), '0.0%' if row == 11 else '0.00')
        style_range(ws, 'H%d:I%d' % (row, row), font=FONT,
                    alignment=Alignment(horizontal='center', vertical='center'))

    band(ws, 28, '保护材料用量（每件产品）：顶部/底部各一整片EPS，局部垫块额外列明')
    header(ws, 29, ['名称', '材质 / 单价单位', '数量', '长 cm', '宽 cm', '厚 cm', '单价', '费用 元', '来源记录'])
    protection_rows = []
    cursor = 30
    for index, item in enumerate(calc.get('protection') or []):
        row = cursor
        cursor += 1
        protection_rows.append(row)
        text(ws, 'A%d' % row, item.get('name'))
        unit_name = {'piece': item.get('unit') or '个', 'volume': 'm³', 'area': 'm²', 'length': 'm'}[item.get('pricing', 'piece')]
        text(ws, 'B%d' % row, '%s / 元/%s' % (item.get('spec') or item.get('material') or '', unit_name))
        set_value(ws, 'C%d' % row, item.get('quantity'))
        dims = item.get('dimensions')
        for col, key in (('D', 'length'), ('E', 'width'), ('F', 'height')):
            if dims:
                number(ws, '%s%d' % (col, row), dims[key])
            else:
                text(ws, '%s%d' % (col, row), '')
        if isinstance(item.get('unitPrice'), (int, float)):
            number(ws, 'G%d' % row, item['unitPrice'])
        pricing = item.get('pricing', 'piece')
        usage = {'volume': 'C%d*D%d*E%d*F%d/1000000' % (row, row, row, row),
                 'area': 'C%d*D%d*E%d/10000' % (row, row, row),
                 'length': 'C%d*D%d/100' % (row, row),
                 'piece': 'C%d' % row}[pricing]
        formula(ws, 'H%d' % row, '=IF(ISNUMBER(G%d),%s*G%d,NA())' % (row, usage, row))
        text(ws, 'I%d' % row, '包材%d' % (index + 1))
        ws.row_dimensions[row].height = 32
        style_range(ws, 'A%d:B%d' % (row, row), font=FONT,
                    alignment=Alignment(vertical='center', wrap_text=True))
        style_range(ws, 'C%d:I%d' % (row, row), font=FONT,
                    alignment=Alignment(horizontal='center', vertical='center', wrap_text=True))
        numfmt(ws, 'G%d:H%d' % (row, row), '0.00')
    protection_total = cursor
    cursor += 1
    text(ws, 'G%d' % protection_total, '保护材料合计')
    formula(ws, 'H%d' % protection_total,
            '=SUM(H%d:H%d)' % (protection_rows[0], protection_rows[-1]) if protection_rows else '=0')
    style_range(ws, 'G%d:H%d' % (protection_total, protection_total), font=FONT,
                alignment=Alignment(vertical='center', wrap_text=True))
    numfmt(ws, 'H%d' % protection_total, '0.00')

    eps = calc.get('epsCoverage') or {}
    if eps.get('required'):
        clearance = eps.get('clearanceCm')
        eligible = [protection_rows[i] for i, item in enumerate(calc.get('protection') or [])
                    if item.get('material') == 'EPS' and item.get('dimensions')]
        terms = ['IF(AND(MAX(D{r}:E{r})>=MAX($B$14:$B$16)-{c},MIN(D{r}:E{r})>=SUM($B$14:$B$16)-MAX($B$14:$B$16)-MIN($B$14:$B$16)-{c}),C{r}*$B$13,0)'
                 .format(r=row, c=clearance) for row in eligible]
        merge(ws, 'F16:G16')
        text(ws, 'F16', '每箱完整EPS片数')
        style_range(ws, 'F16:G16', font=FONT, alignment=Alignment(vertical='center', wrap_text=True))
        merge(ws, 'H16:I16')
        formula(ws, 'H16', '=' + ('+'.join(terms) if terms else '0'))
        style_range(ws, 'H16:I16', font=FONT, alignment=Alignment(horizontal='center', vertical='center'))
        merge(ws, 'F17:I18')
        formula(ws, 'F17', '=IF(H16>=2,"上下整片EPS覆盖通过（至少2片/箱）","EPS整片覆盖不足，阻止确定报价")')
        style_range(ws, 'F17:I18', font=FONT, alignment=Alignment(vertical='center', wrap_text=True))

    carton_section = cursor + 1
    band(ws, carton_section, '纸箱：全搭侧封箱')
    area_row = carton_section + 1
    carton_cost_row = carton_section + 2
    merge(ws, 'A%d:F%d' % (area_row, area_row))
    text(ws, 'A%d' % area_row, '展开面积 m²＝(长＋2×高＋2)×(2×宽＋3×高＋2)÷10000')
    formula(ws, 'H%d' % area_row, '=(B14+2*B16+2)*(2*B15+3*B16+2)/10000')
    style_range(ws, 'A%d:F%d' % (area_row, area_row), font=FONT, alignment=Alignment(vertical='center'))
    style_range(ws, 'H%d' % area_row, font=FONT, alignment=Alignment(horizontal='center', vertical='center'))
    numfmt(ws, 'H%d' % area_row, '0.0000')
    merge(ws, 'A%d:F%d' % (carton_cost_row, carton_cost_row))
    text(ws, 'A%d' % carton_cost_row, '每件产品纸箱费用＝展开面积×平方单价÷每箱产品数')
    formula(ws, 'H%d' % carton_cost_row, '=H%d*B8/B13' % area_row)
    style_range(ws, 'A%d:F%d' % (carton_cost_row, carton_cost_row), font=FONT,
                alignment=Alignment(vertical='center'))
    style_range(ws, 'H%d' % carton_cost_row, font=FONT,
                alignment=Alignment(horizontal='center', vertical='center'))
    numfmt(ws, 'H%d' % carton_cost_row, '0.00')
    cursor = carton_cost_row + 2

    wood_rows = []
    wood_pieces = calc.get('woodPieces') or []
    if wood_pieces:
        band(ws, cursor, '木件体积估重：明确分重优先；缺少参数暂按18mm、650kg/m³')
        cursor += 1
        header(ws, cursor, ['木件', '长 cm', '宽 cm', '厚 cm', '数量', '密度 kg/m³', '重量 kg', '说明', ''])
        cursor += 1
        for index, piece in enumerate(wood_pieces):
            if not piece:
                continue
            row = cursor
            cursor += 1
            wood_rows.append(row)
            text(ws, 'A%d' % row, '木件%d' % (index + 1))
            for col, key in (('B', 'length'), ('C', 'width'), ('D', 'thickness'), ('E', 'quantity'), ('F', 'density')):
                set_value(ws, '%s%d' % (col, row), piece.get(key))
            formula(ws, 'G%d' % row, '=B%d*C%d*D%d*E%d*F%d/1000000' % ((row,) * 6))
            numfmt(ws, 'G%d' % row, '0.000')
            merge(ws, 'H%d:I%d' % (row, row))
            text(ws, 'H%d' % row, piece.get('notes'))
            for col in range(1, 10):
                cell = ws.cell(row=row, column=col)
                cell.font = FONT
                cell.alignment = Alignment(vertical='center', wrap_text=True)
            ws.row_dimensions[row].height = 35

    if net_origin == 'gross':
        formula(ws, 'B17', '=B20-B22-B25')
    elif net_origin == 'material':
        formula(ws, 'B17', '=B18+B19+B21')
    elif net_origin == 'body':
        formula(ws, 'B17', '=B24+B21')
    if net_origin == 'body':
        set_value(ws, 'B24', inp.get('product', {}).get('netWeightKg'))
    elif net_origin == 'material':
        formula(ws, 'B24', '=B18+B19')
    else:
        formula(ws, 'B24', '=B17-B21')
    material = (inp.get('product') or {}).get('material')
    if material == 'metal':
        if not isinstance((inp.get('product') or {}).get('metalWeightKg'), (int, float)):
            formula(ws, 'B19', '=B24')
    elif material == 'wood':
        if not isinstance((inp.get('product') or {}).get('woodWeightKg'), (int, float)):
            formula(ws, 'B18', '=B24')
    elif material == 'mixed':
        if wood_rows:
            formula(ws, 'B18', '=SUM(G%d:G%d)' % (wood_rows[0], wood_rows[-1]))
        if not isinstance((inp.get('product') or {}).get('metalWeightKg'), (int, float)):
            formula(ws, 'B19', '=B24-B18')
        elif not isinstance((inp.get('product') or {}).get('woodWeightKg'), (int, float)) and not wood_rows:
            formula(ws, 'B18', '=B24-B19')

    cursor += 1
    band(ws, cursor, '配件重量拆分：组装必需件计入净重，非组装附带件不计净重')
    cursor += 1
    header(ws, cursor, ['名称', '规格', '每件用量', '单件重 kg', '净重口径', '合计重 kg', '重量来源', '依据', '说明'])
    cursor += 1
    weight_rows = []
    for index, item in enumerate(calc.get('accessories') or []):
        row = cursor
        cursor += 1
        weight_rows.append({'row': row, 'item': item})
        text(ws, 'A%d' % row, item.get('name'))
        text(ws, 'B%d' % row, item.get('spec') or '')
        formula(ws, 'C%d' % row, "='%s'!D%d" % (FRONT, 14 + index))
        weight_per_unit = item.get('weightKgPerUnit')
        if isinstance(weight_per_unit, (int, float)):
            number(ws, 'D%d' % row, weight_per_unit)
            formula(ws, 'F%d' % row, '=C%d*D%d' % (row, row))
        else:
            text(ws, 'D%d' % row, '未逐项分重')
            text(ws, 'F%d' % row, '采用合计依据')
        text(ws, 'E%d' % row, '组装必需件' if item.get('includedInNetWeight', True) else '非组装附带件')
        text(ws, 'G%d' % row, {'user': '用户提供', 'web': '联网参考', 'estimate': '合理估重'}
             .get(item.get('weightSourceType'), '合计分重'))
        text(ws, 'H%d' % row, '重量%d' % (index + 1))
        text(ws, 'I%d' % row, '从净重拆出主料' if item.get('includedInNetWeight', True) else '净重不含，采购成本计入')
        for col in range(1, 10):
            cell = ws.cell(row=row, column=col)
            cell.font = FONT
            cell.alignment = Alignment(vertical='center', wrap_text=True)
        ws.row_dimensions[row].height = 42
        numfmt(ws, 'D%d:F%d' % (row, row), '0.000000')
        note(ws, cursor, '重量%d：%s' % (index + 1, item.get('weightBasis') or '详见配件合计重量依据。'))
        cursor += 1
    for addr, included in (('B21', True), ('B25', False)):
        members = [x for x in weight_rows if bool(x['item'].get('includedInNetWeight', True)) == included]
        if all(isinstance(x['item'].get('weightKgPerUnit'), (int, float)) for x in members):
            formula(ws, addr, '=SUM(%s)' % ','.join('F%d' % x['row'] for x in members) if members else '=0')
            numfmt(ws, addr, '0.000')
    if any(not isinstance(x.get('weightKgPerUnit'), (int, float)) for x in calc.get('accessories') or []):
        note(ws, cursor, '部分配件采用合计分重；改变其BOM用量后必须重新核实合计重量，不能沿用原分重。')
        cursor += 1

    cursor += 1
    band(ws, cursor, '单价来源与采购档位：链接对应具体物料；未公开的起订量标记为“未公布”')
    cursor += 1
    header(ws, cursor, ['物料', '规格', '每件用量', '采购需求', '起订量', '价格档位', '参考单价', '来源', '链接'])
    cursor += 1
    sources = []
    source_records = ([{'item': item, 'index': index, 'kind': 'accessory'}
                       for index, item in enumerate(calc.get('accessories') or [])] +
                      [{'item': item, 'index': index, 'kind': 'protection'}
                       for index, item in enumerate(calc.get('protection') or [])])
    for record in source_records:
        item = record['item']
        index = record['index']
        kind = record['kind']
        row = cursor
        record_id = '%s%d' % ('配件' if kind == 'accessory' else '包材', index + 1)
        sources.append(dict(record, row=row, recordId=record_id))
        text(ws, 'A%d' % row, item.get('name'))
        text(ws, 'B%d' % row, item.get('spec') or '')
        pricing = item.get('pricing', 'piece')
        if kind == 'accessory':
            formula(ws, 'C%d' % row, "='%s'!D%d" % (FRONT, 14 + index))
        else:
            prow = protection_rows[index]
            usage = {'volume': 'C{p}*D{p}*E{p}*F{p}/1000000',
                     'area': 'C{p}*D{p}*E{p}/10000',
                     'length': 'C{p}*D{p}/100',
                     'piece': 'C{p}'}[pricing].format(p=prow)
            formula(ws, 'C%d' % row, '=' + usage)
        formula(ws, 'D%d' % row, '=C%d*$B$12' % row)
        if isinstance(item.get('minOrderQty'), (int, float)):
            number(ws, 'E%d' % row, item['minOrderQty'])
        else:
            text(ws, 'E%d' % row, '未公布')
        text(ws, 'F%d' % row, '%s～%s' % (item.get('priceTierMinQty') if item.get('priceTierMinQty') is not None else '未公布',
                                          item.get('priceTierMaxQty') if item.get('priceTierMaxQty') is not None else '不限'))
        if isinstance(item.get('unitPrice'), (int, float)):
            number(ws, 'G%d' % row, item['unitPrice'])
        else:
            ws['G%d' % row].value = None
        source_name = {'user': '用户提供', 'web': '联网参考', 'template': '原表参考',
                       'estimate': '暂估', 'pending': '待核价'}.get(item.get('sourceType'), item.get('sourceType'))
        text(ws, 'H%d' % row, '%s：%s' % (source_name, item.get('sourceLabel') or ''))
        if item.get('url'):
            text(ws, 'I%d' % row, '打开参考链接')
            add_link(ws, 'I%d' % row, target=item['url'], display='打开参考链接')
        else:
            text(ws, 'I%d' % row, '待补价格' if item.get('sourceType') == 'pending' else '无外部链接')
        for col in range(1, 10):
            cell = ws.cell(row=row, column=col)
            cell.font = FONT
            cell.alignment = Alignment(vertical='center', wrap_text=True)
        ws.row_dimensions[row].height = 49
        numfmt(ws, 'C%d:E%d' % (row, row),
               '0.000000' if pricing == 'volume' else ('0.0000' if pricing in ('area', 'length') else '0'))
        numfmt(ws, 'G%d' % row, '0.00')

        evidence = item.get('priceEvidence')
        if not isinstance(evidence, dict):
            evidence = {}
        average = evidence if evidence.get('method') == 'arithmetic_mean' else None
        target_unit = {'piece': item.get('unit') or '个', 'volume': 'm³', 'area': 'm²', 'length': 'm'}[pricing]
        if average:
            notes = ('记录 %s；%s；%s；%s条有效报价算术平均；范围%s—%s元/%s。各样本及采购档位见下方，'
                     '数量改变导致任一档位失效时须重新查价。' % (
                         record_id, average.get('comparisonKey'), average.get('priceBasis'),
                         average.get('sampleCount'), average.get('min'), average.get('max'),
                         average.get('targetUnit')))
        else:
            notes = '记录 %s；计价单位：元/%s；原始报价单位：%s；查询日期：%s。%s' % (
                record_id, target_unit, item.get('quoteUnit') or target_unit,
                item.get('queriedAt') or '原表/用户输入', item.get('notes') or '')
        mismatch = []
        if isinstance(item.get('minOrderQty'), (int, float)):
            mismatch.append('D%d<E%d' % (row, row))
        if isinstance(item.get('priceTierMinQty'), (int, float)):
            mismatch.append('D%d<%s' % (row, item['priceTierMinQty']))
        if isinstance(item.get('priceTierMaxQty'), (int, float)):
            mismatch.append('D%d>%s' % (row, item['priceTierMaxQty']))
        note(ws, row + 1, notes)
        if mismatch:
            formula(ws, 'A%d' % (row + 1), '=IF(OR(%s),%s,%s)' % (
                ','.join(mismatch), excel_string('采购需求不匹配所选档位，请重新核价。 ' + notes),
                excel_string(notes)))
        if item.get('url'):
            note(ws, row + 2, item['url'])
        else:
            source_type = item.get('sourceType')
            if source_type == 'template':
                extra_note = '模板来源：%s' % (item.get('sourceLabel') or '')
            elif source_type == 'user':
                extra_note = '此单价由用户提供；不是联网市场价格。'
            elif source_type == 'pending':
                extra_note = '未取得有效单价，留空待核；查找情况见上一行。'
            else:
                extra_note = '请补充参考依据。'
            note(ws, row + 2, extra_note)
        cursor += 4
        if average:
            header(ws, cursor, ['供应商', '实际规格', '原始单价', '原报价单位', '目标单位数', '换算单价', '查询日期', 'MOQ及档位', '链接'])
            cursor += 1
            sample_rows = []
            for sample in average.get('samples') or []:
                srow = cursor
                cursor += 1
                sample_rows.append(srow)
                text(ws, 'A%d' % srow, sample.get('supplier'))
                text(ws, 'B%d' % srow, sample.get('selectedSpec'))
                set_value(ws, 'C%d' % srow, sample.get('originalPrice'))
                text(ws, 'D%d' % srow, '元/%s' % sample.get('quoteUnit'))
                set_value(ws, 'E%d' % srow, sample.get('targetUnitsPerQuoteUnit'))
                conditions = ['E%d>0' % srow]
                for key, op in (('minOrderQty', '>='), ('tierMinQty', '>='), ('tierMaxQty', '<=')):
                    if isinstance(sample.get(key), (int, float)):
                        conditions.append('D%d/E%d%s%s' % (row, srow, op, sample[key]))
                formula(ws, 'F%d' % srow, '=IF(AND(%s),C%d/E%d,NA())' % (','.join(conditions), srow, srow))
                text(ws, 'G%d' % srow, sample.get('queriedAt'))
                text(ws, 'H%d' % srow, 'MOQ %s；档位%s—%s %s' % (
                    sample.get('minOrderQty') if sample.get('minOrderQty') is not None else '未公布',
                    sample.get('tierMinQty') if sample.get('tierMinQty') is not None else '未公布',
                    sample.get('tierMaxQty') if sample.get('tierMaxQty') is not None else '未公布',
                    sample.get('quoteUnit')))
                text(ws, 'I%d' % srow, '查看此样本')
                add_link(ws, 'I%d' % srow, target=sample.get('url'), display='查看此样本')
                for col in range(1, 10):
                    cell = ws.cell(row=srow, column=col)
                    cell.font = FONT
                    cell.alignment = Alignment(vertical='center', wrap_text=True)
                ws.row_dimensions[srow].height = 76
                numfmt(ws, 'C%d' % srow, '0.000000')
                numfmt(ws, 'E%d' % srow, '0.######')
                numfmt(ws, 'F%d' % srow, '0.000000')
                observation = '%s / %s；%s；币种%s；%s；%s' % (
                    sample.get('evidenceKind'), sample.get('searchMethod'),
                    sample.get('inputImage') if sample.get('searchMethod') == 'image' else sample.get('keywords'),
                    sample.get('currency'), sample.get('priceKind'), sample.get('observedText'))
                for start in range(0, len(observation), 180):
                    note(ws, cursor, observation[start:start + 180])
                    cursor += 1
                note(ws, cursor, sample.get('url'))
                cursor += 1
            if isinstance(item.get('unitPrice'), (int, float)) and sample_rows:
                formula(ws, 'G%d' % row, '=IF(COUNT(%s)=%d,AVERAGE(%s),NA())' % (
                    ','.join('F%d' % x for x in sample_rows), len(sample_rows),
                    ','.join('F%d' % x for x in sample_rows)))
                numfmt(ws, 'G%d' % row, '0.000000')
            for excluded in average.get('excluded') or []:
                sample = excluded.get('sample') or {}
                note(ws, cursor, '排除：%s；%s；%s' % (
                    sample.get('supplier') or '', sample.get('url') or '',
                    '；'.join(excluded.get('reasons') or [])))
                cursor += 1
            cursor += 1

    band(ws, cursor, '估算、重量与包装说明')
    cursor += 1
    note(ws, cursor, '净重为组装完整产品，含全部必需配件；非组装赠品、备用件及包材不计净重。'
                     '主料重量为净重减已单独计价的组装配件重量。仅毛重时先扣包材和非组装附带件，再拆分主料。')
    cursor += 1
    weight_estimates = calc.get('weightEstimates') or {}
    explanations = list(calc.get('assumptions') or [])
    explanations += [x for x in (
        weight_estimates.get('accessoriesBasis'), weight_estimates.get('extrasBasis'),
        weight_estimates.get('packagingBasis'),
        (inp.get('packaging') or {}).get('notes'), (inp.get('processing') or {}).get('notes')) if x]
    if eps.get('required'):
        explanations.append('上下EPS整片覆盖核对：每片至少%s×%scm，每箱符合完整覆盖的片材%s片；'
                            '局部垫条或小垫块不计入上下整片数量。' % (
                                eps.get('minimumLengthCm'), eps.get('minimumWidthCm'),
                                eps.get('fullPanelsPerCarton')))
    explanations += ['%s：%s' % ('待补' if x.get('severity') == 'blocking' else '提醒', x.get('message'))
                     for x in issues]
    for message in explanations:
        note(ws, cursor, message)
        cursor += 1
    note(ws, cursor, '价格为本次采购条件下的参考。BOM用量或采购批量改变后，应核对价格档位；'
                     '固定包装项沿用原表，不重复计入保护材料。')
    cursor += 1

    # 脚本复算（只读校验）——无 LibreOffice/Excel 重算引擎时的对照区块。
    recalc = plan.get('recalc') or {}
    recalc_start = cursor
    band(ws, cursor, '脚本复算（只读校验）：JS侧 calculate() 静态值；本机无 Excel/LibreOffice 重算引擎，'
                     '公式结果由 buildQuote 读回工作簿静态求值核对')
    cursor += 1
    header(ws, cursor, ['项目', '静态值', '单位', '对应单元格', '说明'])
    header_row = cursor
    cursor += 1
    front = FRONT
    recalc_rows = [
        ('每件成本 C', recalc.get('cost'), '元', 'G%d' % layout['cost'],
         '直接成本：主料+配件+加工+喷涂+保护包材+纸箱+固定包装', '0.00'),
        ('利润 P', recalc.get('profit'), '元', 'G%d' % layout['profit'], '按含税净利率目标反算', '0.00'),
        ('管理费用 M', recalc.get('management'), '元', 'G%d' % layout['management'], '利润×管理费比例', '0.00'),
        ('未税报价 U', recalc.get('untaxed'), '元', 'G%d' % layout['beforeTax'], '成本+利润+管理费', '0.00'),
        ('税金 T', recalc.get('tax'), '元', 'G%d' % layout['tax'], '未税报价×税金参数', '0.00'),
        ('含税报价 Q', recalc.get('taxed'), '元', 'G%d' % layout['afterTax'], '未税报价+税金（EPS覆盖通过）', '0.00'),
        ('实际含税净利率', recalc.get('netMargin'), '比例', 'L%d' % layout['afterTax'], '利润÷含税报价', '0.0%'),
        ('组装净重', weights.get('net'), 'kg', 'B17', '含全部必需配件', '0.000'),
        ('主料本体重量', weights.get('body'), 'kg', 'B24', '组装净重减组装配件', '0.000'),
        ('主料金属重量', weights.get('metal'), 'kg', 'B19', '本体金属', '0.000'),
        ('主料木材重量', weights.get('wood'), 'kg', 'B18', '本体木材', '0.000'),
        ('毛重', weights.get('gross'), 'kg', 'B20', '整件+包材+附带件', '0.000'),
        ('每箱完整EPS片数', eps.get('fullPanelsPerCarton'), '片/箱', 'H16', '上下整片覆盖计数', '0'),
    ]
    for label, value, unit, ref, description, fmt in recalc_rows:
        put(ws, cursor, 1, label)
        if isinstance(value, (int, float)) and math.isfinite(value):
            put(ws, cursor, 2, value, fmt=fmt, align='right')
        else:
            put(ws, cursor, 2, '待核价' if draft else '不适用', align='center')
        put(ws, cursor, 3, unit, align='center')
        put(ws, cursor, 4, "%s!%s" % (front, ref) if ref[0].isalpha() and ref[1:].isdigit() and ref.startswith(('G', 'L')) else '%s!%s' % (BOTTOM, ref), align='center')
        merge(ws, 'E%d:I%d' % (cursor, cursor))
        put(ws, cursor, 5, description, wrap=True)
        style_range(ws, 'A%d:I%d' % (cursor, cursor), font=FONT,
                    alignment=Alignment(vertical='center', wrap_text=True))
        numfmt(ws, 'B%d' % cursor, fmt)
        ws.row_dimensions[cursor].height = 24
        cursor += 1
    recalc_end = cursor - 1
    merge(ws, 'A%d:I%d' % (cursor, cursor))
    text(ws, 'A%d' % cursor,
         '核对方式：导出后由 buildQuote 重新打开本文件，静态求值比较 BOM G%d（含税报价）与上面的静态值（容差1e-6）、'
         'L%d（净利率）与目标净利率（容差1e-9）；不一致会拒绝导出。静态值只读，改价请改上方 B5:B25 公共参数与 BOM 用量。'
         % (layout['afterTax'], layout['afterTax']))
    style_range(ws, 'A%d:I%d' % (cursor, cursor), font=FONT,
                alignment=Alignment(vertical='center', wrap_text=True))
    ws.row_dimensions[cursor].height = 54
    cursor += 1

    last_row = cursor - 1
    ws.freeze_panes = 'A5'

    # 包材行单价回写：保护材料行的单价取自下方单价来源表，避免重复录入。
    for source in sources:
        if source['kind'] != 'protection':
            continue
        prow = protection_rows[source['index']]
        formula(ws, 'G%d' % prow, '=IF(ISNUMBER(G%d),G%d,"")' % (source['row'], source['row']))
        numfmt(ws, 'G%d' % prow, '0.00')

    # 兜底统一字体/垂直居中（band/header 已显式设过，不覆盖）。
    for row in range(1, last_row + 1):
        for col in range(1, 10):
            cell = ws.cell(row=row, column=col)
            if cell.font is None or cell.font.name != 'Microsoft YaHei':
                cell.font = FONT
            current = cell.alignment
            if current is None or current.vertical is None:
                cell.alignment = Alignment(horizontal=current.horizontal if current else None,
                                           vertical='center',
                                           wrap_text=bool(current and current.wrap_text))

    bottom_layout = {
        'lastRow': last_row,
        'titleRow': 1, 'metaRow': 2, 'statusRow': 3, 'parametersStart': 5, 'parametersEnd': 25,
        'protectionBand': 28, 'protectionHeader': 29,
        'protectionStart': protection_rows[0] if protection_rows else None,
        'protectionEnd': protection_rows[-1] if protection_rows else None,
        'protectionTotalRow': protection_total,
        'epsPanelsRow': 16 if eps.get('required') else None,
        'cartonSection': carton_section, 'cartonAreaRow': area_row, 'cartonCostRow': carton_cost_row,
        'woodStart': wood_rows[0] if wood_rows else None, 'woodEnd': wood_rows[-1] if wood_rows else None,
        'weightStart': weight_rows[0]['row'] if weight_rows else None,
        'weightEnd': weight_rows[-1]['row'] if weight_rows else None,
        'sourceStart': sources[0]['row'] if sources else None,
        'sourceEnd': sources[-1]['row'] if sources else None,
        'recalcStart': recalc_start, 'recalcHeader': header_row, 'recalcEnd': recalc_end,
        'sourceRows': {s['recordId']: s['row'] for s in sources},
    }
    return bottom_layout, sources, protection_rows, protection_total, area_row


def excel_string(value):
    return '"%s"' % str(value).replace('"', '""')


# ────────────────────────────────────────────────────────────── 报价BOM
def write_front(ws, plan, sources, protection_total, area_row):
    calc = plan['calc']
    inp = plan['input']
    layout = plan['layout']
    ready = bool(calc.get('ready'))
    weights = calc.get('weights') or {}
    product = calc['product']
    accessories = calc.get('accessories') or []

    # 清空模板残留的 L1:Q7「板材计算表」辅助区：它不在报价打印区域内，
    # 但残留公式会引用空单元格产生 #VALUE!，导出后不应留在成品里。
    for row in range(1, 8):
        for col in range(12, 18):
            cell = ws.cell(row=row, column=col)
            if cell.value is not None:
                cell.value = None

    text(ws, 'A1', '成本核算报价单' if ready else '成本核算报价单（待核价）')
    text(ws, 'B2', product.get('supplier') or '')
    text(ws, 'B3', product.get('developmentId') or '')
    text(ws, 'B4', product.get('name'))
    text(ws, 'G4', product.get('sku') or '')
    number(ws, 'F2', excel_date(product['date']))
    numfmt(ws, 'F2:I2', 'yyyy-mm-dd')
    if isinstance(weights.get('gross'), (int, float)):
        number(ws, 'B5', weights['gross'])
    else:
        text(ws, 'B5', '未提供')
    formula(ws, 'B6', "='%s'!B17" % BOTTOM)
    numfmt(ws, 'B5:D6', '0.000')
    ws.row_dimensions[5].height = 42
    ws.row_dimensions[6].height = 42
    text(ws, 'G5', fmt_dimensions(product.get('cartonDimensions')))
    text(ws, 'G6', fmt_dimensions(product.get('dimensions')))
    formula(ws, 'E8', "='%s'!B19" % BOTTOM)
    formula(ws, 'E9', "='%s'!B18" % BOTTOM)
    formula(ws, 'G8', "='%s'!B5" % BOTTOM)
    formula(ws, 'G9', "='%s'!B6" % BOTTOM)
    formula(ws, 'H8', '=E8*G8')
    formula(ws, 'H9', '=E9*G9')
    numfmt(ws, 'E8:E11', '0.000')
    numfmt(ws, 'G8:H11', '0.00')
    text(ws, 'I8', '净重扣组装配件后主料')

    accessory_sources = [s for s in sources if s['kind'] == 'accessory']
    for index in range(max(2, len(accessories))):
        row = 14 + index
        item = accessories[index] if index < len(accessories) else None
        source = accessory_sources[index] if index < len(accessory_sources) else None
        if item and source:
            text(ws, 'B%d' % row, item.get('name'))
            text(ws, 'C%d' % row, item.get('spec') or '')
            number(ws, 'D%d' % row, item.get('quantity'))
            text(ws, 'F%d' % row, item.get('unit') or 'PCS')
            formula(ws, 'G%d' % row, "=IF(ISNUMBER('%s'!G%d),'%s'!G%d,\"\")" % (BOTTOM, source['row'], BOTTOM, source['row']))
            formula(ws, 'H%d' % row, '=IF(ISNUMBER(G%d),D%d*G%d,NA())' % (row, row, row))
            text(ws, 'I%d' % row, '%s底稿' % source['recordId'])
            add_link(ws, 'I%d' % row, location="'%s'!A%d" % (BOTTOM, source['row']),
                     display='%s底稿' % source['recordId'])
        else:
            for col in ('B', 'C', 'D', 'E', 'F', 'G', 'I'):
                text(ws, '%s%d' % (col, row), '')
            formula(ws, 'H%d' % row, '=0')
        for col in ('B', 'C'):
            cell = ws['%s%d' % (col, row)]
            cell.alignment = Alignment(vertical='center', wrap_text=True)
        ws['I%d' % row].font = FONT_LINK
        numfmt(ws, 'G%d:H%d' % (row, row), '0.00')
        display_length = lambda value: sum(1 if ord(ch) > 255 else 0.55 for ch in str(value or ''))
        longest = max(display_length(item.get('name') if item else ''), display_length(item.get('spec') if item else ''))
        ws.row_dimensions[row].height = max(32, min(60, math.ceil(longest / 8) * 16 + 8))

    formula(ws, 'H%d' % layout['accessorySubtotal'], '=SUM(H14:H%d)' % layout['accessoryEnd'])
    pr = layout['processingStart']
    co = layout['coating']
    formula(ws, 'D%d' % pr, '=E8')
    text(ws, 'F%d' % pr, 'kg')
    formula(ws, 'G%d' % pr, "='%s'!B23" % BOTTOM)
    formula(ws, 'H%d' % pr, '=D%d*G%d' % (pr, pr))
    numfmt(ws, 'D%d' % pr, '0.000')
    text(ws, 'I%d' % pr, '加工成本3元/kg')
    for row in range(pr + 1, pr + 5):
        text(ws, 'D%d' % row, '')
        text(ws, 'F%d' % row, '')
    needs_coating = calc.get('processing', {}).get('needsCoating')
    if needs_coating is True:
        formula(ws, 'D%d' % co, '=E8')
    elif needs_coating is False:
        number(ws, 'D%d' % co, 0)
    else:
        set_value(ws, 'D%d' % co, None)
    formula(ws, 'G%d' % co, "='%s'!B7" % BOTTOM)
    formula(ws, 'H%d' % co, '=D%d*G%d' % (co, co))
    text(ws, 'I%d' % co, '仅本体金属')

    protection = layout['protection']
    number(ws, 'D%d' % protection, 1)
    formula(ws, 'G%d' % protection, "=IF(ISNUMBER('%s'!H%d),'%s'!H%d,\"\")" % (
        BOTTOM, protection_total, BOTTOM, protection_total))
    formula(ws, 'H%d' % protection, '=IF(ISNUMBER(G%d),D%d*G%d,NA())' % (protection, protection, protection))
    text(ws, 'I%d' % protection, '包材用量底稿')
    add_link(ws, 'I%d' % protection, location="'%s'!A28" % BOTTOM, display='包材用量底稿')

    carton = layout['carton']
    formula(ws, 'D%d' % carton, "=1/'%s'!B13" % BOTTOM)
    text(ws, 'F%d' % carton, '箱')
    formula(ws, 'G%d' % carton, "='%s'!H%d*'%s'!B8" % (BOTTOM, area_row, BOTTOM))
    formula(ws, 'H%d' % carton, '=D%d*G%d' % (carton, carton))
    text(ws, 'I%d' % carton, '全搭侧封箱')
    add_link(ws, 'I%d' % carton, location="'%s'!A%d" % (BOTTOM, plan['layout'].get('cartonSection', 0) or 0),
             display='全搭侧封箱')

    cost = layout['cost']
    management = layout['management']
    profit = layout['profit']
    before_tax = layout['beforeTax']
    tax = layout['tax']
    after_tax = layout['afterTax']
    formula(ws, 'G%d' % cost, '=H12+H%d+H%d+H%d' % (
        layout['accessorySubtotal'], layout['processingSubtotal'], layout['packagingSubtotal']))
    text(ws, 'D%d' % before_tax, '未税报价')
    formula(ws, 'G%d' % before_tax, '=SUM(G%d:G%d)' % (cost, profit))
    text(ws, 'D%d' % tax, '税金')
    text(ws, 'D%d' % after_tax, '含税报价')
    if ready:
        formula(ws, 'G%d' % profit,
                "=G%d*'%s'!B10*(1+'%s'!B9)/(1-'%s'!B10*(1+'%s'!B11)*(1+'%s'!B9))" % (
                    cost, BOTTOM, BOTTOM, BOTTOM, BOTTOM, BOTTOM))
        formula(ws, 'G%d' % management, "=G%d*'%s'!B11" % (profit, BOTTOM))
    else:
        formula(ws, 'G%d' % profit, '=NA()')
        formula(ws, 'G%d' % management, '=NA()')
    formula(ws, 'G%d' % tax, "=G%d*'%s'!B9" % (before_tax, BOTTOM))
    if (calc.get('epsCoverage') or {}).get('required'):
        formula(ws, 'G%d' % after_tax, "=IF('%s'!H16>=2,SUM(G%d,G%d),NA())" % (BOTTOM, before_tax, tax))
    else:
        formula(ws, 'G%d' % after_tax, '=SUM(G%d,G%d)' % (before_tax, tax))
    formula(ws, 'L%d' % after_tax, '=G%d/G%d' % (profit, after_tax))
    numfmt(ws, 'L%d' % after_tax, '0.0%')
    numfmt(ws, 'G%d:I%d' % (cost, after_tax), '0.00')
    ws.row_dimensions[before_tax].height = 24
    text(ws, 'B%d' % layout['footer'], inp.get('operator') or '自动核价')
    number(ws, 'E%d' % layout['footer'], excel_date(product['date']))
    numfmt(ws, 'E%d:I%d' % (layout['footer'], layout['footer']), 'yyyy-mm-dd')

    image_path = (plan.get('options') or {}).get('imagePath')
    image_embedded = False
    if image_path and Path(image_path).is_file():
        box = (plan.get('options') or {}).get('imageBox') or {'width': 220, 'height': 137}
        with PILImage.open(image_path) as probe:
            width, height = probe.size
        scale = min(box['width'] / width, box['height'] / height)
        target_w, target_h = max(1, round(width * scale)), max(1, round(height * scale))
        image = XLImage(image_path)
        image.width, image.height = target_w, target_h
        marker = AnchorMarker(col=0, colOff=pixels_to_EMU(4), row=cost - 1, rowOff=pixels_to_EMU(4))
        image.anchor = OneCellAnchor(_from=marker, ext=XDRPositiveSize2D(pixels_to_EMU(target_w), pixels_to_EMU(target_h)))
        ws.add_image(image)
        image_embedded = True
    return image_embedded


# ────────────────────────────────────────────────────────────── 读回校验
def evaluate_and_verify(path, plan):
    workbook = load_workbook(path)
    front = workbook[FRONT]
    bottom = workbook[BOTTOM]
    evaluator = WorkbookEvaluator(workbook)
    layout = plan['layout']

    errors, na_cells, values = [], [], {}

    def evaluate(sheet, row, col, capture=True):
        try:
            result = evaluator.value(sheet, row, col)
        except EvalError as exc:
            errors.append('%s!%s%d: %s' % (sheet, get_column_letter(col), row, exc.code))
            if exc.code == '#N/A':
                na_cells.append('%s!%s%d' % (sheet, get_column_letter(col), row))
            return None
        if capture:
            if isinstance(result, bool):
                values['%s!%s%d' % (sheet, get_column_letter(col), row)] = result
            elif isinstance(result, (int, float)) and math.isfinite(result):
                values['%s!%s%d' % (sheet, get_column_letter(col), row)] = float(result)
            elif isinstance(result, str):
                values['%s!%s%d' % (sheet, get_column_letter(col), row)] = result
        return result

    for sheet_name, worksheet in ((FRONT, front), (BOTTOM, bottom)):
        for row in worksheet.iter_rows(min_col=1, max_col=9):
            for cell in row:
                if cell.data_type == 'f':
                    evaluate(sheet_name, cell.row, cell.column)
                elif isinstance(cell.value, str) and cell.value in ERROR_CODES + ('#N/A',):
                    errors.append('%s!%s: %s' % (sheet_name, cell.coordinate, cell.value))

    key_cells = [('G%d' % layout['cost']), ('G%d' % layout['management']), ('G%d' % layout['profit']),
                 ('G%d' % layout['beforeTax']), ('G%d' % layout['tax']), ('G%d' % layout['afterTax']),
                 ('L%d' % layout['afterTax'])] + ['H%d' % layout['cost'], 'E8', 'E9', 'G8', 'G9', 'B6', 'F2']
    for ref in key_cells:
        evaluate(FRONT, front[ref].row, front[ref].column)
    bottom_keys = ['H9', 'H10', 'H11', 'B17', 'B18', 'B19', 'B20', 'B21', 'B22', 'B24', 'B25']
    for ref in bottom_keys:
        evaluate(BOTTOM, bottom[ref].row, bottom[ref].column)
    bottom_layout = plan.get('bottomLayout') or {}
    for key in ('protectionTotalRow', 'cartonAreaRow', 'cartonCostRow'):
        row = bottom_layout.get(key)
        if row:
            evaluate(BOTTOM, row, 8)
    if (plan.get('calc', {}).get('epsCoverage') or {}).get('required'):
        evaluate(BOTTOM, 16, 8)

    links = []
    for sheet_name, worksheet in ((FRONT, front), (BOTTOM, bottom)):
        for row in worksheet.iter_rows(min_col=1, max_col=9):
            for cell in row:
                link = cell.hyperlink
                if link is None:
                    continue
                links.append({
                    'sheet': sheet_name,
                    'ref': cell.coordinate,
                    'display': link.display or (cell.value if isinstance(cell.value, str) else None),
                    'target': link.target,
                    'location': link.location,
                })

    images = len(getattr(front, '_images', []) or [])
    structural = []

    def expect(condition, message):
        if not condition:
            structural.append(message)

    def fmt_of(sheet, addr):
        return sheet[addr].number_format

    ready = bool(plan['calc'].get('ready'))
    expect(front['A1'].value in ('成本核算报价单', '成本核算报价单（待核价）'), '报价BOM A1 标题缺失')
    expect(front['D%d' % layout['cost']].value == '成本合计', '报价BOM 成本合计标签缺失')
    expect(front['D%d' % layout['beforeTax']].value == '未税报价', '报价BOM 未税报价行缺失')
    expect(front['D%d' % layout['tax']].value == '税金', '报价BOM 税金行缺失')
    expect(front['D%d' % layout['afterTax']].value == '含税报价', '报价BOM 含税报价行缺失')
    expect(front['B6'].value == "='%s'!B17" % BOTTOM, '报价BOM B6 未引用底稿净重')
    expect(front['H%d' % layout['accessorySubtotal']].value == '=SUM(H14:H%d)' % layout['accessoryEnd'],
           '报价BOM 配件小计公式不符')
    expect(front['G%d' % layout['beforeTax']].value == '=SUM(G%d:G%d)' % (layout['cost'], layout['profit']),
           '报价BOM 未税报价公式不符')
    expect(front['L%d' % layout['afterTax']].value == '=G%d/G%d' % (layout['profit'], layout['afterTax']),
           '报价BOM 净利率公式不符')
    expect(str(front['G%d' % layout['afterTax']].value).startswith('='), '报价BOM 含税报价不是公式')
    expect(fmt_of(front, 'L%d' % layout['afterTax']) == '0.0%', '报价BOM 净利率格式不是0.0%')
    expect(front['B4'].value == plan['calc']['product'].get('name'), '报价BOM 产品名称不符')
    def mapped(n):
        return n + (layout['extra'] if n >= 16 else 0) + (1 if n >= 37 else 0)

    for merge_ref in ('A1:I1', 'B2:D2', 'A8:A11', 'A12:G12', 'A13:A%d' % (15 + layout['extra']),
                      'A%d:G%d' % (mapped(16), mapped(16)),
                      'A%d:A%d' % (mapped(17), mapped(23)),
                      'A%d:G%d' % (mapped(24), mapped(24)),
                      'A%d:A%d' % (mapped(25), mapped(32)),
                      'A%d:G%d' % (mapped(33), mapped(33)),
                      'A%d:A%d' % (mapped(34), mapped(38)),
                      'B5:D5', 'B6:D6',
                      'D%d:F%d' % (layout['beforeTax'], layout['beforeTax']),
                      'G%d:I%d' % (layout['beforeTax'], layout['beforeTax'])):
        expect(merge_ref in {str(x) for x in front.merged_cells.ranges}, '报价BOM 缺少合并区域 %s' % merge_ref)
    accessory_count = len(plan['calc'].get('accessories') or [])
    for index in range(max(2, accessory_count)):
        row_no = 14 + index
        name = front['B%d' % row_no].value
        filled = []
        for col in 'BCDEFGH':
            cell_value = front['%s%d' % (col, row_no)].value
            if cell_value in (None, ''):
                continue
            # 保留行里 H 列固定写 '=0'，不算半填数据
            if col == 'H' and cell_value in ('=0', 0):
                continue
            filled.append(col)
        if index < accessory_count:
            expect(bool(name), '报价BOM 第%d条配件行为空' % (index + 1))
        else:
            # 模板至少保留 2 条配件行；只有 1 条配件时，多出来的保留行必须整行留空，
            # 不能出现「有数量没名称」这类半填数据。
            expect(not filled, '报价BOM 第%d条配件行出现半填数据（保留行应整行留空）：%s'
                   % (index + 1, ','.join(filled)))

    expect(bottom['A1'].value == '报价底稿', '报价底稿 A1 标题缺失')
    expect(bottom['A5'].value == '铁单价', '报价底稿 参数表缺失')
    expect(bottom['H9'].value == "='%s'!G%d" % (FRONT, layout['beforeTax']), '报价底稿 H9 未引用未税报价')
    expect(bottom['H10'].value == "='%s'!G%d" % (FRONT, layout['afterTax']), '报价底稿 H10 未引用含税报价')
    expect(bottom['H11'].value == "='%s'!L%d" % (FRONT, layout['afterTax']), '报价底稿 H11 未引用净利率')
    if (plan['calc'].get('epsCoverage') or {}).get('required'):
        expect(isinstance(bottom['H16'].value, str) and bottom['H16'].value.startswith('='), '报价底稿 H16 缺少EPS片数公式')
        expect('F17:I18' in {str(x) for x in bottom.merged_cells.ranges}, '报价底稿 缺少EPS覆盖结论合并区')
    recalc_start = (plan.get('bottomLayout') or {}).get('recalcStart')
    expect(bool(recalc_start) and isinstance(bottom['A%d' % recalc_start].value, str)
           and '脚本复算' in bottom['A%d' % recalc_start].value, '报价底稿 缺少脚本复算区块')
    expect(bottom.max_row >= (plan.get('bottomLayout') or {}).get('recalcEnd', 1), '报价底稿 复算区块不完整')

    # 打印设置（BOM A4 纵向一页；底稿 A3 横向按列宽适配）。
    front_setup = front.page_setup
    expect(str(front_setup.paperSize) == '9', '报价BOM paperSize 不是 A4（9）')
    expect(front_setup.orientation == 'portrait', '报价BOM 不是纵向')
    expect(str(front_setup.fitToWidth) == '1' and str(front_setup.fitToHeight) == '1', '报价BOM 不是一页适配')
    expect(front.sheet_properties.pageSetUpPr is not None and front.sheet_properties.pageSetUpPr.fitToPage is True,
           '报价BOM 未设置 fitToPage')
    expect(bool(front.print_area), '报价BOM 缺少打印区域')
    bottom_setup = bottom.page_setup
    expect(str(bottom_setup.paperSize) == '8', '报价底稿 paperSize 不是 A3（8）')
    expect(bottom_setup.orientation == 'landscape', '报价底稿 不是横向')
    expect(str(bottom_setup.fitToWidth) == '1' and str(bottom_setup.fitToHeight) == '0', '报价底稿 打印适配不符')
    expect(bottom.sheet_properties.pageSetUpPr is not None and bottom.sheet_properties.pageSetUpPr.fitToPage is True,
           '报价底稿 未设置 fitToPage')

    expect(workbook.calculation is not None and bool(workbook.calculation.fullCalcOnLoad),
           '工作簿未设置 calcPr fullCalcOnLoad=1')
    expect(str(front['B6'].value or '').startswith('='), '报价BOM 未保留公式引用')

    # 同一单元格可能被「全表扫描」与「关键单元格复核」各算一次，去重后只保留一条。
    errors = list(dict.fromkeys(errors))
    na_cells = list(dict.fromkeys(na_cells))
    blocking_errors = [item for item in errors if '#N/A' not in item]
    report = {
        # 草稿单允许 #N/A（缺价），但其它公式错误与结构问题一律失败。
        'ok': not structural and not blocking_errors and (not ready or not na_cells),
        'sheets': [
            {'name': FRONT, 'lastRow': layout['footer'], 'lastColumn': 9,
             'maxRow': front.max_row, 'maxColumn': front.max_column},
            {'name': BOTTOM, 'lastRow': (plan.get('bottomLayout') or {}).get('lastRow', bottom.max_row),
             'lastColumn': 9, 'maxRow': bottom.max_row, 'maxColumn': bottom.max_column},
        ],
        'formulaErrors': [x for x in errors if '#N/A' not in x],
        'allFormulaErrors': errors,
        'naCells': na_cells,
        'structuralErrors': structural,
        'values': values,
        'links': links,
        'imageEmbedded': bool(images),
        'imageCount': images,
        'merged': {'报价BOM': sorted(str(x) for x in front.merged_cells.ranges),
                   '报价底稿': sorted(str(x) for x in bottom.merged_cells.ranges)},
        'bottomLayout': plan.get('bottomLayout'),
        'frontLabels': {'A1': front['A1'].value,
                        'B4': front['B4'].value,
                        'G5': front['G5'].value,
                        'G6': front['G6'].value},
    }
    return report


def build(plan, out_path):
    options = plan.get('options') or {}
    work_dir = Path(options.get('workDir') or Path(out_path).parent)
    work_dir.mkdir(parents=True, exist_ok=True)
    expanded = Path(options.get('expandedPath') or (work_dir / 'expanded-template.xlsx'))
    template = Path(options.get('templatePath') or TEMPLATE)
    if not template.is_file():
        raise FileNotFoundError('BOM模板不存在：%s' % template)
    expand_template(template, expanded, len(plan['calc'].get('accessories') or []))
    workbook = load_workbook(expanded)
    if FRONT not in workbook.sheetnames:
        workbook[workbook.sheetnames[0]].title = FRONT
    front = workbook[FRONT]
    bottom = workbook.create_sheet(BOTTOM)

    bottom_layout, sources, _protection_rows, protection_total, area_row = write_bottom(bottom, plan)
    plan['bottomLayout'] = bottom_layout
    if plan['layout'].get('cartonSection') is None:
        plan['layout']['cartonSection'] = bottom_layout['cartonSection']
    write_front(front, plan, sources, protection_total, area_row)

    last_row = bottom_layout['lastRow']
    front.print_area = 'A1:I%d' % plan['layout']['footer']
    front.sheet_properties.pageSetUpPr = PageSetupProperties(fitToPage=True)
    front.page_setup.paperSize = 9
    front.page_setup.orientation = 'portrait'
    front.page_setup.fitToWidth = 1
    front.page_setup.fitToHeight = 1
    bottom.print_area = 'A1:I%d' % last_row
    bottom.sheet_properties.pageSetUpPr = PageSetupProperties(fitToPage=True)
    bottom.page_setup.paperSize = 8
    bottom.page_setup.orientation = 'landscape'
    bottom.page_setup.fitToWidth = 1
    bottom.page_setup.fitToHeight = 0
    if workbook.calculation is None:
        workbook.calculation = CalcProperties(fullCalcOnLoad=True)
    workbook.calculation.fullCalcOnLoad = True
    workbook.calculation.calcMode = 'auto'
    workbook.save(out_path)
    return plan


def main(argv=None):
    parser = argparse.ArgumentParser(description='生成 hardware-quote 两表报价工作簿。')
    parser.add_argument('--plan', required=True, help='plan JSON 路径')
    parser.add_argument('--out', help='输出 xlsx 路径（默认用 plan.options.output）')
    parser.add_argument('--report', help='校验报告 JSON 路径（默认与输出同名 .report.json）')
    args = parser.parse_args(argv)
    plan_path = Path(args.plan).resolve()
    report_path = Path(args.report).resolve() if args.report else plan_path.with_suffix('.report.json')
    try:
        plan = json.loads(plan_path.read_text(encoding='utf-8'))
        out_path = Path(args.out or plan['options']['output']).resolve()
        plan['options']['workDir'] = str((plan.get('options') or {}).get('workDir') or out_path.parent)
        plan = build(plan, out_path)
        report = evaluate_and_verify(out_path, plan)
        report['output'] = str(out_path)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
        if not report['ok']:
            detail = report['formulaErrors'] + report['structuralErrors']
            if report['naCells'] and plan['calc'].get('ready'):
                detail += ['就绪报价出现 #N/A：' + cell for cell in report['naCells']]
            print('\n'.join(detail) or '工作簿校验失败', file=sys.stderr)
            return 2
        print(json.dumps({'ok': True, 'output': str(out_path), 'report': str(report_path),
                          'sheets': report['sheets']}, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001 - 报错要原样回传给 JS
        payload = {'ok': False, 'error': '%s: %s' % (type(exc).__name__, exc),
                   'traceback': traceback.format_exc()}
        try:
            report_path.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
        except Exception:
            pass
        print(payload['error'], file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
