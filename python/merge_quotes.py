# -*- coding: utf-8 -*-
"""把多份「两表报价」工作簿合并成一个交付工作簿。

合并规则（与历史交付一致）：
- 每个产品一张工作表，工作表名形如 ``01_产品简称``；
- 表内上半部是「报价BOM」（模板原样，行号不变），下半部接「报价底稿」，
  底稿第 1 行落在 BOM 页脚之后第 4 行；
- 两表的列宽取逐列最大值（保证两段内容都能读）；
- 公式、合并单元格、超链接、图片、行高、数字格式全部随内容搬运，
  公式里的跨表引用改写成本表引用（底稿行号整体下移）。
"""
from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from io import BytesIO
from pathlib import Path

import openpyxl
from openpyxl.drawing.image import Image as XLImage
from openpyxl.styles import Alignment, Border, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.hyperlink import Hyperlink

FRONT = '报价BOM'
BOTTOM = '报价底稿'
FRONT_COLS = 12             # 报价BOM 右侧 L 列有净利率等公式，底稿会引用
GAP = 4                     # BOM 页脚与底稿标题之间空 3 行
DEFAULT_COL_WIDTH = 8.43

# 单元格引用（可带表名前缀）与区域
REF = re.compile(
    r"(?:(?P<sheet>'[^']+'|[A-Za-z\u4e00-\u9fff_][A-Za-z0-9\u4e00-\u9fff_.]*)!)?"
    r"(?P<ref>\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)"
)
ENDPOINT = re.compile(r'(?P<cdollar>\$?)(?P<col>[A-Z]{1,3})(?P<rdollar>\$?)(?P<row>\d+)')
STRING_LITERAL = re.compile(r'("(?:[^"]|"")*")')


def _shift_ref(ref: str, delta: int) -> str:
    if delta == 0:
        return ref
    out = []
    for endpoint in ref.split(':'):
        m = ENDPOINT.fullmatch(endpoint)
        if not m:
            return ref
        out.append('%s%s%s%d' % (m.group('cdollar'), m.group('col'), m.group('rdollar'), int(m.group('row')) + delta))
    return ':'.join(out)


def rewrite_formula(formula: str, *, block_delta: int, bottom_delta: int) -> str:
    """把公式里的引用改写为本表引用。

    block_delta  : 当前区块自身行偏移（BOM=0，底稿=bottom_delta）。
    bottom_delta : 底稿第 1 行在目标表里的行号 - 1。
    """
    if not isinstance(formula, str) or not formula.startswith('='):
        return formula
    pieces = STRING_LITERAL.split(formula)
    for index in range(0, len(pieces), 2):          # 偶数下标 = 代码片段，奇数 = 字符串字面量
        chunk = pieces[index]

        def repl(match: re.Match) -> str:
            sheet = match.group('sheet')
            if sheet:
                name = sheet.strip("'")
                if name == FRONT:
                    delta = 0
                elif name == BOTTOM:
                    delta = bottom_delta
                else:
                    return match.group(0)
            else:
                delta = block_delta
            return _shift_ref(match.group('ref'), delta)

        pieces[index] = REF.sub(repl, chunk)
    return ''.join(pieces)


def _copy_style(src, dst) -> None:
    if not src.has_style:
        return
    dst.font = copy.copy(src.font)
    dst.border = copy.copy(src.border)
    dst.fill = copy.copy(src.fill)
    dst.number_format = src.number_format
    dst.protection = copy.copy(src.protection)
    dst.alignment = copy.copy(src.alignment)


def _rewrite_location(location: str | None, delta: int) -> str | None:
    if not location:
        return location
    text = location
    if '!' in text:
        sheet, _, ref = text.rpartition('!')
        name = sheet.strip("'")
        if name == BOTTOM:
            return _shift_ref(ref, delta)
        if name == FRONT:
            return _shift_ref(ref, 0)
        return text
    return _shift_ref(text, delta)


def _copy_block(src_ws, dst_ws, *, rows, cols, row_offset, block_delta, bottom_delta, images):
    for r in range(1, rows + 1):
        for c in range(1, cols + 1):
            s = src_ws.cell(r, c)
            d = dst_ws.cell(r + row_offset, c)
            if isinstance(s.value, str) and s.value.startswith('='):
                d.value = rewrite_formula(s.value, block_delta=block_delta, bottom_delta=bottom_delta)
            elif s.value is not None:
                d.value = s.value
            _copy_style(s, d)
            if s.hyperlink is not None:
                link = s.hyperlink
                d.hyperlink = Hyperlink(
                    ref=d.coordinate,
                    target=link.target,
                    location=_rewrite_location(link.location, bottom_delta) if link.location else None,
                    tooltip=link.tooltip,
                    display=link.display,
                )
        height = src_ws.row_dimensions[r].height
        if height is not None:
            dst_ws.row_dimensions[r + row_offset].height = height
    if images:
        for image in images:
            data = image.ref
            if hasattr(data, 'getvalue'):
                payload = data.getvalue()
            elif isinstance(data, (bytes, bytearray)):
                payload = bytes(data)
            else:
                continue
            new_image = XLImage(BytesIO(payload))
            new_image.width = image.width
            new_image.height = image.height
            anchor = copy.copy(image.anchor)
            try:
                anchor._from.row = anchor._from.row + row_offset
            except Exception:
                pass
            new_image.anchor = anchor
            dst_ws.add_image(new_image)


def _copy_merges(src_ws, dst_ws, *, rows, row_offset):
    for merged in src_ws.merged_cells.ranges:
        if merged.min_row <= rows:
            dst_ws.merge_cells(start_row=merged.min_row + row_offset, start_column=merged.min_col,
                               end_row=min(merged.max_row, rows) + row_offset, end_column=merged.max_col)


def _max_widths(*sources) -> dict:
    widths = {}
    for ws in sources:
        for key, dim in ws.column_dimensions.items():
            if dim.width:
                widths[key] = max(widths.get(key, 0), dim.width)
    return widths


def _footer_row(ws) -> int:
    for r in range(1, ws.max_row + 1):
        value = ws.cell(r, 1).value
        if isinstance(value, str) and value.strip().startswith('IE核价员'):
            return r
    return ws.max_row


def build_product_sheet(target, source_path: Path, title: str):
    src = openpyxl.load_workbook(source_path)
    front, bottom = src[FRONT], src[BOTTOM]
    front_last = _footer_row(front)
    bottom_last = bottom.max_row
    bottom_start = front_last + GAP
    bottom_delta = bottom_start - 1

    sheet = target.create_sheet(title=title)
    sheet.sheet_view.showGridLines = False

    _copy_block(front, sheet, rows=front_last, cols=FRONT_COLS, row_offset=0,
                block_delta=0, bottom_delta=bottom_delta,
                images=list(getattr(front, '_images', []) or []))
    _copy_block(bottom, sheet, rows=bottom_last, cols=FRONT_COLS, row_offset=bottom_delta,
                block_delta=bottom_delta, bottom_delta=bottom_delta, images=[])
    _copy_merges(front, sheet, rows=front_last, row_offset=0)
    _copy_merges(bottom, sheet, rows=bottom_last, row_offset=bottom_delta)

    for key, width in _max_widths(front, bottom).items():
        sheet.column_dimensions[key].width = width

    last_row = bottom_delta + bottom_last
    sheet.print_area = 'A1:I%d' % last_row
    sheet.sheet_properties.pageSetUpPr = copy.copy(front.sheet_properties.pageSetUpPr)
    sheet.page_setup.orientation = 'landscape'
    sheet.page_setup.fitToWidth = 1
    sheet.page_setup.fitToHeight = 0
    return {'title': title, 'frontRows': front_last, 'bottomRows': bottom_last,
            'bottomStart': bottom_start, 'lastRow': last_row}


def write_summary(workbook, summary: dict):
    headers = summary.get('headers') or []
    rows = summary.get('rows') or []
    notes = summary.get('notes') or []
    title = summary.get('title') or ''

    ws = workbook.create_sheet(index=0, title='00_汇总')
    ws.sheet_view.showGridLines = False
    thin = openpyxl.styles.Side(style='thin', color='B7B7B7')
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    if title:
        ws.cell(1, 1, title).font = Font(name='Microsoft YaHei', size=12, bold=True)
        ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=max(len(headers), 1))
        ws.cell(1, 1).alignment = Alignment(vertical='center')
    head_row = 2 if title else 1
    fill = PatternFill('solid', fgColor='DDEBF7')
    for index, head in enumerate(headers, 1):
        cell = ws.cell(head_row, index, head)
        cell.font = Font(name='Microsoft YaHei', bold=True)
        cell.fill = fill
        cell.border = border
        cell.alignment = Alignment(wrap_text=True, horizontal='center', vertical='center')
    for offset, row in enumerate(rows, 1):
        for index, value in enumerate(row, 1):
            cell = ws.cell(head_row + offset, index, value)
            cell.border = border
            cell.font = Font(name='Microsoft YaHei')
            if isinstance(value, float):
                cell.number_format = '0.0000'
            if len(str(value)) > 24:
                cell.alignment = Alignment(wrap_text=True, vertical='center')
        ws.row_dimensions[head_row + offset].height = 32
    widths = summary.get('widths') or []
    for index, width in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(index)].width = width

    if notes:
        note_ws = workbook.create_sheet(index=1, title='00_口径说明')
        note_ws.sheet_view.showGridLines = False
        for offset, line in enumerate(notes, 1):
            cell = note_ws.cell(offset, 1, line)
            cell.alignment = Alignment(wrap_text=True, vertical='top')
            cell.font = Font(name='Microsoft YaHei')
            note_ws.row_dimensions[offset].height = 34
        note_ws.column_dimensions['A'].width = 120


def main(argv=None):
    parser = argparse.ArgumentParser(description='多产品报价合并为一个工作簿（每产品一张分表）。')
    parser.add_argument('--source', action='append', required=True, help='源工作簿（可重复，顺序即分表顺序）')
    parser.add_argument('--name', action='append', default=None, help='分表名（可重复，缺省用源文件名）')
    parser.add_argument('--summary', help='汇总 JSON（title/headers/rows/notes/widths）')
    parser.add_argument('--out', required=True, help='输出 xlsx 路径')
    args = parser.parse_args(argv)

    sources = [Path(item) for item in args.source]
    names = list(args.name or [])
    workbook = openpyxl.Workbook()
    workbook.remove(workbook.active)

    summary = {}
    if args.summary:
        summary = json.loads(Path(args.summary).read_text(encoding='utf-8'))
    if summary:
        write_summary(workbook, summary)

    sheets = []
    for index, source in enumerate(sources):
        if index < len(names) and names[index]:
            title = names[index]
        else:
            title = re.sub(r'[\\/:*?"<>|]+', '_', source.stem)[:31]
        sheets.append(build_product_sheet(workbook, source, title))

    if workbook.calculation is None:
        from openpyxl.workbook.properties import CalcProperties
        workbook.calculation = CalcProperties(fullCalcOnLoad=True)
    workbook.calculation.fullCalcOnLoad = True
    workbook.calculation.calcMode = 'auto'

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    workbook.save(out)
    print(json.dumps({'ok': True, 'output': str(out.resolve()), 'sheets': sheets}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
