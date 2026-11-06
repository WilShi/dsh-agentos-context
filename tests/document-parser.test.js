import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadableStream as NativeReadableStream } from 'node:stream/web';
import {
  MAX_BINARY_DOCUMENT_BYTES,
  MAX_TEXT_DOCUMENT_BYTES,
  prepareKnowledgeDocument,
} from '../src/document-parser.js';
import { restoreNativeReadableStream } from '../src/web-runtime-compat.js';

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const localParts = [], centralParts = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const filename = Buffer.from(name), data = Buffer.from(text), checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    localParts.push(local, filename, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, filename);
    offset += local.length + filename.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

const contentTypes = overrides => `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides}</Types>`;
const relationship = (type, target) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${type}" Target="${target}"/></Relationships>`;
const officeRelationship = target => relationship('http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', target);

function docx() {
  return zip({
    '[Content_Types].xml': contentTypes('<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'),
    '_rels/.rels': officeRelationship('word/document.xml'),
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX parser hello</w:t></w:r></w:p><w:sectPr/></w:body></w:document>',
  });
}

function xlsx() {
  return zip({
    '[Content_Types].xml': contentTypes('<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'),
    '_rels/.rels': officeRelationship('xl/workbook.xml'),
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': relationship('http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet', 'worksheets/sheet1.xml'),
    'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>XLSX parser hello</t></is></c></row></sheetData></worksheet>',
  });
}

function pptx() {
  return zip({
    '[Content_Types].xml': contentTypes('<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'),
    '_rels/.rels': officeRelationship('ppt/presentation.xml'),
    'ppt/presentation.xml': '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': relationship('http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide', 'slides/slide1.xml'),
    'ppt/slides/slide1.xml': '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:sp><p:nvSpPr/><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>PPTX parser hello</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
  });
}

const odfMimeTypes = {
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  odg: 'application/vnd.oasis.opendocument.graphics',
};

function odf(extension, body) {
  return zip({
    mimetype: odfMimeTypes[extension],
    'content.xml': `<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"><office:body>${body}</office:body></office:document-content>`,
  });
}

function epub() {
  return zip({
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'OEBPS/content.opf': '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0"><metadata><dc:title>Parser fixture</dc:title></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
    'OEBPS/chapter.xhtml': '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>EPUB parser hello</p></body></html>',
  });
}

function pdf() {
  const parts = ['%PDF-1.4\n'], offsets = [0];
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const body of objects) {
    offsets.push(Buffer.byteLength(parts.join('')));
    parts.push(`${offsets.length - 1} 0 obj\n${body}\nendobj\n`);
  }
  const stream = 'BT /F1 12 Tf 72 720 Td (PDF parser hello) Tj ET';
  offsets.push(Buffer.byteLength(parts.join('')));
  parts.push(`5 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream\nendobj\n`);
  const xref = Buffer.byteLength(parts.join(''));
  parts.push('xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(value => String(value).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(parts.join(''));
}

const fixtures = [
  ['rtf', Buffer.from('{\\rtf1\\ansi RTF parser hello}'), 'RTF parser hello'],
  ['docx', docx(), 'DOCX parser hello'],
  ['xlsx', xlsx(), 'XLSX parser hello'],
  ['pptx', pptx(), 'PPTX parser hello'],
  ['pdf', pdf(), 'PDF parser hello'],
  ['odt', odf('odt', '<office:text><text:p>ODT parser hello</text:p></office:text>'), 'ODT parser hello'],
  ['ods', odf('ods', '<office:spreadsheet><table:table table:name="Sheet1"><table:table-row><table:table-cell office:value-type="string"><text:p>ODS parser hello</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet>'), 'ODS parser hello'],
  ['odp', odf('odp', '<office:presentation><draw:page draw:name="page1"><draw:frame><draw:text-box><text:p>ODP parser hello</text:p></draw:text-box></draw:frame></draw:page></office:presentation>'), 'ODP parser hello'],
  ['odg', odf('odg', '<office:drawing><draw:page draw:name="page1"><draw:frame><draw:text-box><text:p>ODG parser hello</text:p></draw:text-box></draw:frame></draw:page></office:drawing>'), 'ODG parser hello'],
  ['epub', epub(), 'EPUB parser hello'],
];

for (const [extension, bytes, expected] of fixtures) {
  test(`extracts bounded local text from ${extension.toUpperCase()}`, async () => {
    const result = await prepareKnowledgeDocument({
      filename: `sample.${extension}`,
      mimeType: 'application/octet-stream',
      dataBase64: bytes.toString('base64'),
    });
    assert.match(result.content, new RegExp(expected));
    assert.equal(result.sourceFormat, extension);
    assert.equal(result.sourceBytes, bytes.length);
  });
}

test('rejects corrupt, mismatched, unsupported and oversized documents', async () => {
  await assert.rejects(prepareKnowledgeDocument({ filename: 'broken.docx', dataBase64: Buffer.from('not a zip').toString('base64') }), { code: 'DOCUMENT_PARSE_FAILED' });
  await assert.rejects(prepareKnowledgeDocument({ filename: 'wrong.docx', dataBase64: pdf().toString('base64') }), { code: 'DOCUMENT_PARSE_FAILED' });
  await assert.rejects(prepareKnowledgeDocument({ filename: 'legacy.doc', dataBase64: Buffer.from('legacy').toString('base64') }), { code: 'DOCUMENT_FORMAT_UNSUPPORTED' });
  await assert.rejects(prepareKnowledgeDocument({ filename: 'huge.txt', content: 'x'.repeat(MAX_TEXT_DOCUMENT_BYTES + 1) }), { code: 'LIMIT_EXCEEDED' });
  const oversizedBase64 = 'A'.repeat(Math.ceil(MAX_BINARY_DOCUMENT_BYTES / 3) * 4 + 4);
  await assert.rejects(prepareKnowledgeDocument({ filename: 'huge.pdf', dataBase64: oversizedBase64 }), { code: 'LIMIT_EXCEEDED' });
});

test('honours cancellation before parser work starts', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(prepareKnowledgeDocument({ filename: 'cancel.rtf', dataBase64: fixtures[0][1].toString('base64') }, { signal: controller.signal }), { code: 'ABORTED' });
});

test('restores the native ReadableStream identity required by Node fetch', () => {
  const ForeignReadableStream = class ReadableStream {};
  globalThis.ReadableStream = ForeignReadableStream;
  assert.equal(restoreNativeReadableStream(), true);
  assert.equal(globalThis.ReadableStream, NativeReadableStream);
  assert.equal(restoreNativeReadableStream(), false);
});
