#!/usr/bin/env python3
"""Builds the synthetic Word fixture rich.docx (mixed fonts/languages, white text, tracked changes, a table, a link)."""
import sys, zipfile
out = sys.argv[1] if len(sys.argv) > 1 else "rich.docx"
W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
def run(t, rsid, rpr=''): return f'<w:r w:rsidR="{rsid}"><w:rPr>{rpr}</w:rPr><w:t xml:space="preserve">{t}</w:t></w:r>'
lorem = "The model treats each chord as a state and counts how often one chord follows another in the data set. "
P = [f'<w:p w:rsidR="00A1"><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>{run("Introduction","00A1")}</w:p>']
for i in range(6): P.append(f'<w:p w:rsidR="00A1">{run(lorem*3, "00A1" if i < 3 else "00B2")}</w:p>')
P.append(f'<w:p w:rsidR="00C3">{run("A Markov chain is a stochastic process describing a sequence of possible events in which the probability of each event depends only on the state attained in the previous event, as “quoted” here and &quot;there&quot;.", "00C3", "<w:rFonts w:ascii=\"Arial\" w:hAnsi=\"Arial\"/><w:sz w:val=\"21\"/><w:lang w:val=\"en-US\"/><w:color w:val=\"202122\"/>")}</w:p>')
P.append(f'<w:p w:rsidR="00B2">{run("**Key idea** the matrix columns sum to one.", "00B2")}{run(" secret white words here", "00B2", "<w:color w:val=\"FFFFFF\"/>")}</w:p>')
P.append(f'<w:p w:rsidR="00B2"><w:ins w:id="1" w:author="Teacher" w:date="2026-03-02T10:00:00Z">{run("Added after feedback on the method section.", "00D4")}</w:ins><w:del w:id="2" w:author="Teacher" w:date="2026-03-05T10:00:00Z"><w:r><w:delText>old words</w:delText></w:r></w:del>{run(" See link.", "00B2")}<w:hyperlink r:id="rId9">{run("source", "00B2")}</w:hyperlink></w:p>')
P.append('<w:tbl><w:tr><w:tc><w:p>' + run("cell text", "00B2") + '</w:p></w:tc></w:tr></w:tbl>')
doc = f'<?xml version="1.0" encoding="UTF-8"?><w:document {W}><w:body>{"".join(P)}<w:sectPr/></w:body></w:document>'
styles = f'<?xml version="1.0"?><w:styles {W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/><w:sz w:val="24"/><w:lang w:val="en-AU"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="32"/></w:rPr></w:style></w:styles>'
theme = '<?xml version="1.0"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:fontScheme><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>'
settings = f'<?xml version="1.0"?><w:settings {W}><w:rsids><w:rsidRoot w:val="00A1"/><w:rsid w:val="00A1"/><w:rsid w:val="00B2"/><w:rsid w:val="00C3"/><w:rsid w:val="00D4"/><w:rsid w:val="00E5"/></w:rsids></w:settings>'
rels = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="hyperlink" Target="https://en.wikipedia.org/wiki/Markov_chain" TargetMode="External"/></Relationships>'
core = '<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>S</dc:creator><dcterms:created>2026-02-20T09:00:00Z</dcterms:created><dcterms:modified>2026-03-06T09:00:00Z</dcterms:modified><cp:revision>14</cp:revision></cp:coreProperties>'
app = '<?xml version="1.0"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><TotalTime>95</TotalTime><Application>Microsoft Office Word</Application></Properties>'
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for n, c in [('word/document.xml', doc), ('word/styles.xml', styles), ('word/theme/theme1.xml', theme), ('word/settings.xml', settings), ('word/_rels/document.xml.rels', rels), ('docProps/core.xml', core), ('docProps/app.xml', app), ('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')]: z.writestr(n, c)
print("wrote", out)
