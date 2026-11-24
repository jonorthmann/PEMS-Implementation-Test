import { createServer } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, link, unlink, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'csv-parse/sync';
import { ManagedIdentityCredential } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';
import { createPdf, forms } from './report.js';

const env=process.env;
const azure=Boolean(env.PEMS_BLOB_ENDPOINT||env.PEMS_BLOB_CONTAINER);
const live=azure||env.NODE_ENV==='production';
if(live&&(!env.PEMS_ROSTER||!env.PEMS_ORIGIN?.startsWith('https://')||!env.PEMS_SECRET||env.PEMS_SECRET.length<32)){
  throw new Error('Configure PEMS_ROSTER, HTTPS PEMS_ORIGIN, and a stable random PEMS_SECRET of at least 32 characters.');
}
if(azure&&(!env.PEMS_BLOB_ENDPOINT?.startsWith('https://')||!env.PEMS_BLOB_CONTAINER)){
  throw new Error('Both PEMS_BLOB_ENDPOINT (HTTPS) and PEMS_BLOB_CONTAINER are required.');
}
const secret=env.PEMS_SECRET||'local-fictional-test-only';
const assessment=env.PEMS_ASSESSMENT||'TR-2026-014';
const normalize=value=>typeof value==='string'?value.trim().replace(/[\s-]/g,''):'';
const roster=new Map();
const rosterPath=env.PEMS_ROSTER||new URL('./fixtures/candidates.csv',import.meta.url);
const csv=parse(await readFile(rosterPath),{bom:true,columns:true,skip_empty_lines:true,trim:true});
for(const row of csv){
  const id=normalize(row.emirates_id);
  if(!/^\d{15}$/.test(id)||!row.name||row.name.length>200||roster.has(id)){
    throw new Error('Invalid or duplicate candidate in roster. Expected emirates_id,name with unique 15-digit IDs.');
  }
  roster.set(id,row.name);
}
if(!roster.size)throw new Error('The roster must contain at least one candidate.');
const page=await readFile(new URL('./public/index.html',import.meta.url),'utf8');
const html=page.replace('<!-- TEST IDS -->',env.PEMS_ROSTER?'':'<p class="muted">Fictional test IDs: 000000000000001 and 000000000000002</p>');
const container=azure?new BlobServiceClient(env.PEMS_BLOB_ENDPOINT,new ManagedIdentityCredential())
  .getContainerClient(env.PEMS_BLOB_CONTAINER):null;
const directory=env.PEMS_OUTPUT||'submissions';
if(!container)await mkdir(directory,{recursive:true,mode:0o700});

const sessions=new Map(), limits=new Map();
const lifetime=8*60*60*1000;
const timer=setInterval(()=>{
  for(const [token,session] of sessions)if(session.expires<Date.now())sessions.delete(token);
  for(const [ip,limit] of limits)if(limit.until<Date.now())limits.delete(ip);
},60_000);
timer.unref();
const digest=value=>createHmac('sha256',secret).update(value).digest('hex');
const cookie=(value,age)=>'pems_session='+value+'; Path=/; HttpOnly; SameSite=Strict; Max-Age='+age+(live?'; Secure':'');
const token=req=>req.headers.cookie?.match(/(?:^|;\s*)pems_session=([a-f0-9]{64})(?:;|$)/)?.[1];

function json(res,status,data,headers={}){
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8',...headers});
  res.end(JSON.stringify(data));
}
async function payload(req){
  if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw Object.assign(new Error('Expected JSON.'),{status:415});
  let bytes=0,overLimit=false;
  const chunks=[];
  for await(const chunk of req){
    bytes+=chunk.length;
    if(bytes>1024*1024)overLimit=true;
    if(!overLimit)chunks.push(chunk);
  }
  if(overLimit)throw Object.assign(new Error('Submission is too large.'),{status:413});
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch{throw Object.assign(new Error('Invalid JSON.'),{status:400});}
}
function validateRecords(input){
  if(!Array.isArray(input)||!input.length||input.length>500)throw new Error('Submit between 1 and 500 saved records.');
  const ids=new Set(), exhibits=new Set();
  const rows=input.map(row=>{
    if(!row||!Object.hasOwn(forms,row.kind)||!Number.isSafeInteger(row.id)||row.id<1||ids.has(row.id))throw new Error('A record has an invalid reference or type.');
    ids.add(row.id);
    if(row.kind==='exhibit')exhibits.add(row.id);
    const record={id:row.id,kind:row.kind,exhibit:row.exhibit??null};
    for(const key of Object.keys(forms[row.kind].fields)){
      const value=row[key]??'';
      if(typeof value!=='string'||value.length>4000)throw new Error('A form field is invalid or longer than 4,000 characters.');
      record[key]=value.trim();
    }
    if(!record.time||(row.kind!=='transfer'&&!record.description))throw new Error('A record is missing its time or description.');
    return record;
  });
  for(const row of rows){
    if(row.kind==='exhibit')continue;
    if(row.kind==='video'&&row.exhibit===null)continue;
    if(!exhibits.has(row.exhibit))throw new Error('A record references an exhibit outside this submission.');
  }
  return rows;
}
async function saveReport(session,records){
  const filename=session.attempt+'.pdf';
  const submittedAt=new Date(Math.floor(Date.now()/1000)*1000).toISOString();
  const pdf=await createPdf({...session,caseRef:assessment,submittedAt,records});
  if(container){
    const blob=container.getBlockBlobClient(filename);
    try{
      await blob.uploadData(pdf,{conditions:{ifNoneMatch:'*'},blobHTTPHeaders:{blobContentType:'application/pdf'},
        metadata:{submittedat:submittedAt}});
      return submittedAt;
    }catch(error){
      if(error.statusCode!==409&&error.statusCode!==412)throw error;
      const existing=await blob.getProperties();
      if(!existing.metadata?.submittedat)throw error;
      return existing.metadata.submittedat;
    }
  }
  const target=join(directory,filename);
  const temporary=target+'.'+randomBytes(12).toString('hex')+'.tmp';
  try{
    await writeFile(temporary,pdf,{flag:'wx',mode:0o600,flush:true});
    await utimes(temporary,new Date(submittedAt),new Date(submittedAt));
    try{await link(temporary,target);return submittedAt;}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      return (await stat(target)).mtime.toISOString();
    }
  }finally{await unlink(temporary).catch(()=>{});}
}

const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  try{
    if(req.method==='GET'&&req.url==='/'){
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);return;
    }
    if(req.method!=='POST'||!['/api/login','/api/logout','/api/submissions'].includes(req.url)){
      json(res,404,{error:'Not found.'});return;
    }
    const origin=env.PEMS_ORIGIN||'http://'+req.headers.host;
    if(req.headers.origin!==origin){json(res,403,{error:'Open PEMS at its configured web address.'});return;}
    if(req.url==='/api/login'){
      const ip=req.socket.remoteAddress;
      const now=Date.now();
      let limit=limits.get(ip);
      if(!limit||limit.until<now){limit={count:0,until:now+60_000};limits.set(ip,limit);}
      if(limit.count>=30){json(res,429,{error:'Wait a minute before trying again.'});return;}
      const id=normalize((await payload(req))?.emiratesId);
      if(!/^\d{15}$/.test(id)){
        json(res,400,{error:'Enter exactly 15 digits. Do not include letters or other symbols.'});return;
      }
      const name=roster.get(id);
      if(!name){limit.count++;json(res,401,{error:'This Emirates ID was not found on the assessment roster. Check the number or speak to your assessor.'});return;}
      sessions.delete(token(req));
      const key=randomBytes(32).toString('hex');
      const attempt='PEMS-'+digest(JSON.stringify([assessment,id])).slice(0,24).toUpperCase();
      sessions.set(key,{name,attempt,expires:now+lifetime});
      json(res,200,{name,attempt},{'Set-Cookie':cookie(key,lifetime/1000)});return;
    }
    if(req.url==='/api/logout'){
      sessions.delete(token(req));
      json(res,200,{signedOut:true},{'Set-Cookie':cookie('',0)});return;
    }
    const session=sessions.get(token(req));
    if(!session||session.expires<Date.now()){json(res,401,{error:'Sign in again to submit this attempt.'});return;}
    const body=await payload(req);
    if(body?.attempt!==session.attempt){json(res,409,{error:'This tab is linked to a different candidate attempt. Sign in again.'});return;}
    let records;
    try{records=validateRecords(body.records);}
    catch(error){json(res,400,{error:error.message});return;}
    const submittedAt=await saveReport(session,records);
    json(res,200,{attempt:session.attempt,submittedAt,filename:session.attempt+'.pdf'});
  }catch(error){
    if(!error.status)console.error('PEMS request failed:',error.code||error.name);
    if(!res.headersSent)json(res,error.status||503,{error:error.status?error.message:'Could not save the submission. Your records are available to retry.'});
  }
});
server.listen(Number(env.PORT||3000),env.HOST||(live?'0.0.0.0':'127.0.0.1'),()=>{
  console.log('PEMS listening on port '+server.address().port);
});
