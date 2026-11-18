import { createHash } from 'node:crypto';
import { deflateSync, deflateRawSync } from 'node:zlib';
import { PDFDocument, PDFName } from '../../vendor/pdf-lib/pdf-lib.esm.min.js';

export async function streamPdf(mode) {
  const pdf=await PDFDocument.create(),page=pdf.addPage([300,500]);
  const plain=Buffer.from('q 1 0 0 rg 20 20 40 40 re f Q'),compressed=deflateSync(plain);
  const bytes=mode==='missing-adler' ? compressed.subarray(0,-4)
    : mode==='raw' ? deflateRawSync(plain)
    : mode==='trailing' ? Buffer.concat([compressed,Buffer.from([0,255,1,10])]) : compressed;
  page.node.set(PDFName.of('Contents'),pdf.context.register(pdf.context.stream(bytes,{Filter:'FlateDecode'})));
  return pdf.save({useObjectStreams:true});
}

const pad=Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a','hex');
const md5=bytes=>createHash('md5').update(bytes).digest();
const password=value=>Buffer.concat([Buffer.from(value),pad]).subarray(0,32);
function rc4(key,bytes) {
  const s=Array.from({length:256},(_,i)=>i);let j=0;
  for(let i=0;i<256;i++){j=(j+s[i]+key[i%key.length])&255;[s[i],s[j]]=[s[j],s[i]];}
  let i=0;j=0;return Buffer.from(bytes.map(b=>{i=(i+1)&255;j=(j+s[i])&255;[s[i],s[j]]=[s[j],s[i]];return b^s[(s[i]+s[j])&255];}));
}

// Standard Security revision 2, genuine RC4-encrypted page stream. No tools,
// external fixtures or dependencies are required to exercise empty-user access.
export function encryptedPdf(user='') {
  const id=Buffer.from('00112233445566778899aabbccddeeff','hex');
  const owner=rc4(md5(password('owner-secret')).subarray(0,5),password(user));
  const permissions=Buffer.alloc(4);permissions.writeInt32LE(-4);
  const key=md5(Buffer.concat([password(user),owner,permissions,id])).subarray(0,5);
  const u=rc4(key,pad),objectKey=md5(Buffer.concat([key,Buffer.from([4,0,0,0,0])])).subarray(0,10);
  const stream=rc4(objectKey,Buffer.from('q 1 0 0 rg 20 20 40 40 re f Q'));
  const objects=[
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 500] /Resources << >> /Contents 4 0 R >>'),
    Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`),stream,Buffer.from('\nendstream')]),
    Buffer.from(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${owner.toString('hex')}> /U <${u.toString('hex')}> /P -4 >>`)
  ];
  const chunks=[Buffer.from('%PDF-1.4\n')],offsets=[0];let size=chunks[0].length;
  objects.forEach((obj,i)=>{offsets.push(size);const chunk=Buffer.concat([Buffer.from(`${i+1} 0 obj\n`),obj,Buffer.from('\nendobj\n')]);chunks.push(chunk);size+=chunk.length;});
  const xref=size,entries=offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('');
  chunks.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${entries}trailer\n<< /Size 6 /Root 1 0 R /Encrypt 5 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>] >>\nstartxref\n${xref}\n%%EOF`));
  return Buffer.concat(chunks);
}
