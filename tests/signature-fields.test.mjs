import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';

const require=createRequire(import.meta.url);
const {PDFDocument,StandardFonts,rgb,PDFArray,decodePDFRawStream}=require('pdf-lib');
const source=await readFile(new URL('../netlify/functions/portal.mjs',import.meta.url),'utf8');
const start=source.indexOf('async function packet(');
const end=source.indexOf('\nexport default async function handle(',start);
assert.ok(start>=0&&end>start,'Load the same packet function used by the portal.');
const requireThat=(condition,message)=>{assert.ok(condition,message);};
const packet=new Function('PDFDocument','StandardFonts','rgb','requireThat',source.slice(start,end)+'\nreturn packet;')(PDFDocument,StandardFonts,rgb,requireThat);

const master=await PDFDocument.create();
const first=master.addPage([612,792]);
master.addPage([612,792]);
const form=master.getForm();
for(const [index,name] of ['Actor name or professional name','Role or character','Daily rate (USD)'].entries()){
 form.createTextField(name).addToPage(first,{x:48,y:710-index*35,width:240,height:22});
}
const original=Buffer.from(await master.save());
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const originalDigest=digest(original);
const result=await packet(original,{credit:'Example Member',character:'Supporting Actor',rate:'100',legal:'Example Member',date:'2026-11-09'});
assert.equal(digest(original),originalDigest,'Preparing a request must preserve the unsigned master bytes.');
const output=await PDFDocument.load(result);
assert.equal(output.getPageCount(),2,'Field placement must retain the original page count.');
const firstPageStreams=output.getPage(0).node.Contents();
const firstPageText=firstPageStreams.asArray().map(reference=>Buffer.from(decodePDFRawStream(output.context.lookup(reference)).decode()).toString('latin1')).join('\n');
const services="This Agreement covers Actor's services already performed for the Picture and any future services mutually agreed.";
const firstPageStrings=[...firstPageText.matchAll(/<([A-Fa-f0-9]+)>\s*Tj/g)].map(match=>Buffer.from(match[1],'hex').toString('latin1'));
assert.ok(firstPageStrings.includes(services),'The generated agreement must cover past services and mutually agreed future services without a first shoot date.');
assert.ok(!firstPageStrings.some(value=>value.includes('scheduled to begin on')||value.includes('undefined')),'No missing or historical start date may appear in the new services clause.');

function tagFields(page,pageNumber){
 const contents=page.node.Contents();
 const streams=contents instanceof PDFArray?contents.asArray().map(reference=>output.context.lookup(reference)):[contents];
 const fields=[];
 for(const stream of streams){
  const commands=Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
  for(const block of commands.matchAll(/BT([\s\S]*?)ET/g)){
   const text=block[1].match(/<([A-Fa-f0-9]+)>\s*Tj/);
   if(!text)continue;
   const value=Buffer.from(text[1],'hex').toString('latin1');
   const tag=value.match(/^\{\{(.+?)\}\}$/);
   if(!tag)continue;
   const matrices=[...block[1].matchAll(/([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+Tm/g)];
   assert.ok(matrices.length,'A signing tag must have an explicit position in the generated PDF.');
   const matrix=matrices.at(-1);
   fields.push({parts:tag[1].trim().split(':'),x:Number(matrix[5]),y:Number(matrix[6]),page:pageNumber});
  }
 }
 return fields;
}
const fields=output.getPages().flatMap((page,index)=>tagFields(page,index+1));
assert.equal(fields.length,6,'Each signer needs separate signature, printed name and signing date fields.');
for(const [signer,x] of [['1',310],['2',52]]){
 const signerFields=fields.filter(field=>field.parts[1]===signer);
 assert.equal(signerFields.length,3);
 for(const [type,top] of [['s',414],['af_n',457],['d',500]]){
  const matches=signerFields.filter(field=>field.parts[0]===type);
  assert.equal(matches.length,1,'Each signer must have one distinct '+type+' field.');
  const field=matches[0];
  assert.equal(field.parts[2],'y','Every signing field must be required.');
  assert.equal(field.page,2,'Execution fields belong on the second page.');
  assert.equal(field.x,x);
  assert.equal(field.y,792-top,'The field must remain on its own execution line.');
 }
 const date=signerFields.find(field=>field.parts[0]==='d');
 assert.equal(date.parts[8],'y','The ninth date option must lock the actual signing date.');
 assert.equal(date.parts[9],'mm/dd/yyyy');
 assert.deepEqual(date.parts.slice(6,8),['120','24']);
 assert.notEqual(signerFields.find(field=>field.parts[0]==='s').y,signerFields.find(field=>field.parts[0]==='af_n').y,'Signature and printed name must occupy separate lines.');
}
console.log('PASS: real PDF packet preserves its master and places six required fields on separate signature, printed-name and locked signing-date lines for both parties.');
