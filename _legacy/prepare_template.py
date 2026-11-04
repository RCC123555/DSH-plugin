"""Only expand native template rows/merges before Artifact Tool authors the output.

The spreadsheet API has no documented row insertion primitive. Preserve the original
styles and section layout with this narrowly scoped standard-library OOXML transform.
"""
import argparse
import copy
import re
import zipfile
import xml.etree.ElementTree as ET

NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
ET.register_namespace('', NS)
ET.register_namespace('r', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')
ET.register_namespace('mc', 'http://schemas.openxmlformats.org/markup-compatibility/2006')
ET.register_namespace('x14ac', 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac')
def q(tag): return '{'+NS+'}'+tag

def prepare(source, target, count):
    extra = max(2, count)-2
    def mapped(n): return n+(extra if n>=16 else 0)+(1 if n>=37 else 0)
    def refs(text):
        return re.sub(r'(\$?[A-Z]{1,3}\$?)(\d+)', lambda m:m[1]+str(mapped(int(m[2]))), text)
    with zipfile.ZipFile(source) as zin:
        data={name:zin.read(name) for name in zin.namelist()}
    root=ET.fromstring(data['xl/worksheets/sheet1.xml'])
    sd=root.find(q('sheetData'))
    originals={int(row.get('r')):copy.deepcopy(row) for row in sd}
    if 15 not in originals or 37 not in originals: raise ValueError('不匹配的BOM模板：缺少配件或税金行。')
    for row in sd:
        row.set('r',str(mapped(int(row.get('r')))))
        for c in row:
            if 'r' in c.attrib:c.set('r',refs(c.get('r')))
            f=c.find(q('f'))
            if f is not None:
                if f.text:f.text=refs(f.text)
                if 'ref' in f.attrib:f.set('ref',refs(f.get('ref')))
    for n in range(extra):
        row=copy.deepcopy(originals[15]);new_r=16+n;row.set('r',str(new_r))
        for c in row:
            c.set('r',re.sub(r'\d+$',str(new_r),c.get('r')))
            for child in list(c):c.remove(child)
            c.attrib.pop('t',None)
        sd.append(row)
    row=copy.deepcopy(originals[37]);new_r=37+extra;row.set('r',str(new_r))
    for c in row:
        c.set('r',re.sub(r'\d+$',str(new_r),c.get('r')))
        for child in list(c):c.remove(child)
        c.attrib.pop('t',None)
    sd.append(row)
    sd[:]=sorted(sd,key=lambda row:int(row.get('r')))
    # Extend the hardware category, unmerge remarks for per-material provenance.
    merges=root.find(q('mergeCells'))
    for merge in list(merges):
        old=merge.get('ref')
        if old=='I14:I15':merges.remove(merge);continue
        merge.set('ref',f'A13:A{15+extra}' if old=='A13:A15' else refs(old))
    for ref in [f'D{new_r}:F{new_r}',f'G{new_r}:I{new_r}']:
        ET.SubElement(merges,q('mergeCell'),{'ref':ref})
    merges.set('count',str(len(merges)))
    # Explicitly include inserted accessory lines in their subtotal.
    subtotal=next(c for row in sd for c in row if c.get('r')==f'H{16+extra}')
    f=subtotal.find(q('f'));f.text=f'SUM(H14:H{15+extra})'
    root.find(q('dimension')).set('ref',refs(root.find(q('dimension')).get('ref')))
    data['xl/worksheets/sheet1.xml']=ET.tostring(root,encoding='utf-8',xml_declaration=True)
    wb=ET.fromstring(data['xl/workbook.xml'])
    sheets=wb.find(q('sheets'))
    if len(sheets)!=1:raise ValueError('BOM模板必须只有一个工作表。')
    sheets[0].set('name','报价BOM')
    names=wb.find(q('definedNames'))
    if names is None:names=ET.SubElement(wb,q('definedNames'))
    for name in names:
        if name.text:name.text=refs(name.text).replace('Sheet1','报价BOM')
    ET.SubElement(names,q('definedName'),{'name':'_xlnm.Print_Area','localSheetId':'0'}).text=f"'报价BOM'!$A$1:$I${40+extra}"
    data['xl/workbook.xml']=ET.tostring(wb,encoding='utf-8',xml_declaration=True)
    if 'xl/calcChain.xml' in data:
        chain=ET.fromstring(data['xl/calcChain.xml'])
        for c in chain:
            if 'r' in c.attrib:c.set('r',refs(c.get('r')))
        data['xl/calcChain.xml']=ET.tostring(chain,encoding='utf-8',xml_declaration=True)
    with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED) as zout:
        for name,content in data.items():zout.writestr(name,content)

if __name__=='__main__':
    p=argparse.ArgumentParser(description='保留原格式，扩展必要的配件行和未税报价行。')
    p.add_argument('source');p.add_argument('target');p.add_argument('--accessories',type=int,default=2)
    a=p.parse_args()
    if a.accessories<0:raise ValueError('配件行数不能为负。')
    prepare(a.source,a.target,a.accessories)
