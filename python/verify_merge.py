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
from merge_quotes import BOTTOM, FRONT, LANDING, LANDING_COLS, FRONT_COLS, rewrite_formula  # noqa: E402

COLS = FRONT_COLS
BLOCKS = (LANDING, FRONT, BOTTOM)


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
    for pair in pairs:
        sheet_name, source = pair[0], pair[1]
        landing_rows, front_rows, bottom_rows = pair[2], pair[3], pair[4]
        landing_start, front_start, bottom_start = pair[5], pair[6], pair[7]
        ws = wb[sheet_name]
        src = openpyxl.load_workbook(source)
        deltas = {FRONT: front_start - 1, BOTTOM: bottom_start - 1}
        if LANDING in src.sheetnames:
            deltas[LANDING] = landing_start - 1
        plan = {
            LANDING: (landing_rows, deltas.get(LANDING, 0), LANDING_COLS),
            FRONT: (front_rows, deltas[FRONT], COLS),
            BOTTOM: (bottom_rows, deltas[BOTTOM], COLS),
        }
        value_mismatch = []
        formula_mismatch = []
        for sheet_const in BLOCKS:
            if sheet_const not in src.sheetnames:
                continue
            rows, offset, cols = plan[sheet_const]
            sws = src[sheet_const]
            for r in range(1, rows + 1):
                for c in range(1, cols + 1):
                    s = sws.cell(r, c)
                    d = ws.cell(r + offset, c)
                    if isinstance(s.value, str) and s.value.startswith('='):
                        expected = rewrite_formula(s.value, block_delta=offset, deltas=deltas)
                        if d.value != expected:
                            formula_mismatch.append(
                                {'cell': d.coordinate, 'expected': expected, 'actual': d.value}
                            )
                    elif not _same(s.value, d.value):
                        value_mismatch.append(
                            {'cell': d.coordinate, 'expected': s.value, 'actual': d.value}
                        )
        src_blocks = [src[name] for name in BLOCKS if name in src.sheetnames]
        src_merges = sum(len(block.merged_cells.ranges) for block in src_blocks)
        dst_merges = len(ws.merged_cells.ranges)
        src_links = sum(1 for block in src_blocks for row in block.iter_rows() for cell in row if cell.hyperlink)
        dst_links = sum(1 for row in ws.iter_rows() for cell in row if cell.hyperlink)
        src_images = sum(len(getattr(block, '_images', []) or []) for block in src_blocks)
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
