"""Add native hyperlinks and print settings missing from the spreadsheet SDK.

No business values, formulas, formatting or media are rewritten here.
"""
import argparse
import json
import os
import shutil
import tempfile
import zipfile
import xml.etree.ElementTree as ET

NS='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
REL='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
PKG='http://schemas.openxmlformats.org/package/2006/relationships'
ET.register_namespace('',NS)
ET.register_namespace('r',REL)
def q(tag):return '{'+NS+'}'+tag

def updated_parts(zin,metadata):
    # Keep only the small XML parts being changed, never decompressed images.
    data={}
    wb=ET.fromstring(zin.read('xl/workbook.xml'))
    names=wb.find(q('definedNames'))
    if names is None:
        names=ET.Element(q('definedNames'))
        # definedNames precedes calcPr and later workbook elements in OOXML.
        children=list(wb);sheets=wb.find(q('sheets'));wb.insert(children.index(sheets)+1,names)
    for child in list(names):
        if child.get('name')=='_xlnm.Print_Area':names.remove(child)
    for i,(sheet,end) in enumerate([('报价BOM',metadata['frontLastRow']),('报价底稿',metadata['bottomLastRow'])]):
        ET.SubElement(names,q('definedName'),{'name':'_xlnm.Print_Area','localSheetId':str(i)}).text=f"'{sheet}'!$A$1:$I${end}"
        name=f'xl/worksheets/sheet{i+1}.xml';root=ET.fromstring(zin.read(name))
        sheet_pr=root.find(q('sheetPr'))
        if sheet_pr is None:
            sheet_pr=ET.Element(q('sheetPr'));root.insert(0,sheet_pr)
        setup_pr=sheet_pr.find(q('pageSetUpPr'))
        if setup_pr is None:setup_pr=ET.SubElement(sheet_pr,q('pageSetUpPr'))
        setup_pr.set('fitToPage','1')
        setup=root.find(q('pageSetup'))
        if setup is None:
            setup=ET.Element(q('pageSetup'))
            before={'headerFooter','rowBreaks','colBreaks','customProperties','cellWatches','ignoredErrors','smartTags','drawing','legacyDrawing','legacyDrawingHF','picture','oleObjects','controls','webPublishItems','tableParts','extLst'}
            idx=next((j for j,c in enumerate(root) if c.tag.split('}')[-1] in before),len(root));root.insert(idx,setup)
        # BOM fits one A4 page; wide audit details use A3 landscape and flow vertically.
        setup.attrib.pop('scale',None)
        setup.set('paperSize','9' if i==0 else '8')
        setup.set('orientation','portrait' if i==0 else 'landscape')
        setup.set('fitToWidth','1');setup.set('fitToHeight','1' if i==0 else '0')
        for tag in ['rowBreaks','colBreaks']:
            breaks=root.find(q(tag))
            if breaks is not None:root.remove(breaks)
        if i==1 and metadata.get('bottomPageBreakRows'):
            rows=sorted(set(int(r)-1 for r in metadata['bottomPageBreakRows'] if 1<int(r)<=end))
            breaks=ET.Element(q('rowBreaks'),{'count':str(len(rows)),'manualBreakCount':str(len(rows))})
            for row in rows:ET.SubElement(breaks,q('brk'),{'id':str(row),'min':'0','max':'16383','man':'1'})
            before={'colBreaks','customProperties','cellWatches','ignoredErrors','smartTags','drawing','legacyDrawing','legacyDrawingHF','picture','oleObjects','controls','webPublishItems','tableParts','extLst'}
            idx=next((j for j,c in enumerate(root) if c.tag.split('}')[-1] in before),len(root));root.insert(idx,breaks)
        links=[x for x in metadata['hyperlinks'] if x['sheet']==sheet]
        if links:
            node=root.find(q('hyperlinks'))
            if node is None:
                node=ET.Element(q('hyperlinks'))
                before={'printOptions','pageMargins','pageSetup','headerFooter','rowBreaks','colBreaks','customProperties','cellWatches','ignoredErrors','smartTags','drawing','legacyDrawing','legacyDrawingHF','picture','oleObjects','controls','webPublishItems','tableParts','extLst'}
                idx=next((j for j,c in enumerate(root) if c.tag.split('}')[-1] in before),len(root));root.insert(idx,node)
            relname=f'xl/worksheets/_rels/sheet{i+1}.xml.rels'
            try:relbytes=zin.read(relname)
            except KeyError:relbytes=None
            relroot=ET.fromstring(relbytes) if relbytes is not None else ET.Element('{'+PKG+'}Relationships')
            used={c.get('Id') for c in relroot}
            for link in links:
                attrs={'ref':link['ref'],'display':link['display']}
                if 'location' in link:attrs['location']=link['location']
                else:
                    n=1
                    while 'rId'+str(n) in used:n+=1
                    rid='rId'+str(n);used.add(rid);attrs['{'+REL+'}id']=rid
                    ET.SubElement(relroot,'{'+PKG+'}Relationship',{'Id':rid,'Type':REL+'/hyperlink','Target':link['target'],'TargetMode':'External'})
                ET.SubElement(node,q('hyperlink'),attrs)
            if len(relroot):data[relname]=ET.tostring(relroot,encoding='utf-8',xml_declaration=True)
        data[name]=ET.tostring(root,encoding='utf-8',xml_declaration=True)
    data['xl/workbook.xml']=ET.tostring(wb,encoding='utf-8',xml_declaration=True)
    return data


def finalize(filename,metadata):
    # Atomic replacement of only the just-created, caller-owned output file.
    tmp=None
    try:
        with zipfile.ZipFile(filename) as zin:
            data=updated_parts(zin,metadata)
            fd,tmp=tempfile.mkstemp(prefix='.hardware-quote-',suffix='.xlsx',dir=os.path.dirname(os.path.abspath(filename)))
            os.close(fd)
            with zipfile.ZipFile(tmp,'w',zipfile.ZIP_DEFLATED) as zout:
                zout.comment=zin.comment
                # A dict also retains the old implementation's last-member-wins
                # behavior if a source archive contains duplicate member names.
                members={info.filename:info for info in zin.infolist()}
                for name,info in members.items():
                    if name in data:zout.writestr(info,data.pop(name))
                    else:
                        with zin.open(info) as source,zout.open(info,'w') as target:
                            shutil.copyfileobj(source,target,1024*1024)
                for name,content in data.items():zout.writestr(name,content)
        os.replace(tmp,filename)
    finally:
        if tmp is not None and os.path.exists(tmp):os.unlink(tmp)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('xlsx');p.add_argument('metadata');a=p.parse_args()
    with open(a.metadata,encoding='utf-8') as f:metadata=json.load(f)
    finalize(a.xlsx,metadata)
