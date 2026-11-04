# -*- coding: utf-8 -*-
"""静态校验「多产品合并工作簿」：逐格比对静态值与公式（按合并规则重写后的文本）。

不需要 Excel/LibreOffice：公式只比文本，因此可确认合并时行号改写、字符串字面量、
跨表引用都没有走样；金额是否算对由各款单wk簿的 checks 保证。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import openpyxl

sys.path.insert(0, str(Path(__file__).resolve().parent))
from merge_quotes import BOTTOM, FRONT, rewrite_formula  # noqa: E402

COLS = 12


def _same(a, b):
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(float(a) - float(b)) <= 1e-9 * max(1.0, abs(float(a)))
    return a == b


def main() -> int:
    if len(sys.argv) < 3:
        print('usage: verify_merge.py <merged.xlsx> <pairs.json>', file=sys.stderr)
        return 2
    merged_path, pairs_path = Path(sys.argv[1]), Path(sys.argv[2])
    pairs = json.loads(pairs_path.read_text(encoding='utf-8'))
    wb = openpyxl.load_workbook(merged_path)
    sheets = []
    ok = True
    for sheet_name, source, front_rows, bottom_rows, bottom_start in pairs:
        ws = wb[sheet_name]
        src = openpyxl.load_workbook(source)
        delta = bottom_start - 1
        value_mismatch = []
        formula_mismatch = []
        for block, rows, offset, sheet_const in (
            ('front', front_rows, 0, FRONT),
            ('bottom', bottom_rows, delta, BOTTOM),
        ):
            sws = src[sheet_const]
            block_delta = 0 if block == 'front' else delta
            for r in range(1, rows + 1):
                for c in range(1, COLS + 1):
                    s = sws.cell(r, c)
                    d = ws.cell(r + offset, c)
                    if isinstance(s.value, str) and s.value.startswith('='):
                        expected = rewrite_formula(s.value, block_delta=block_delta, bottom_delta=delta)
                        if d.value != expected:
                            formula_mismatch.append(
                                {'cell': d.coordinate, 'expected': expected, 'actual': d.value}
                            )
                    elif not _same(s.value, d.value):
                        value_mismatch.append(
                            {'cell': d.coordinate, 'expected': s.value, 'actual': d.value}
                        )
        src_merges = len(src[FRONT].merged_cells.ranges) + len(src[BOTTOM].merged_cells.ranges)
        dst_merges = len(ws.merged_cells.ranges)
        src_links = sum(
            1 for name in (FRONT, BOTTOM) for row in src[name].iter_rows() for cell in row if cell.hyperlink
        )
        dst_links = sum(1 for row in ws.iter_rows() for cell in row if cell.hyperlink)
        src_images = len(getattr(src[FRONT], '_images', []) or []) + len(getattr(src[BOTTOM], '_images', []) or [])
        dst_images = len(getattr(ws, '_images', []) or [])
        if src_merges != dst_merges or src_links != dst_links or src_images != dst_images:
            ok = False
        if value_mismatch or formula_mismatch:
            ok = False
        sheets.append(
            {
                'sheet': sheet_name,
                'valueMismatch': value_mismatch[:10],
                'formulaMismatch': formula_mismatch[:10],
                'merges': [src_merges, dst_merges],
                'links': [src_links, dst_links],
                'images': [src_images, dst_images],
            }
        )
    print(json.dumps({'ok': ok, 'sheets': sheets}, ensure_ascii=False))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
