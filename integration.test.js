import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('private CSV lookup and one PDF per candidate attempt', {timeout:20000}, async ()=>{
  const directory=await mkdtemp(join(tmpdir(),'pems-test-'));
  const roster=join(directory,'roster.csv');
  const output=join(directory,'submissions');
  await writeFile(roster,'emirates_id,name\n000000000000003,"Nora, Training"\n000000000000004,Sam Example\n');
  const server=spawn(process.execPath,['server.js'],{
    env:{...process.env,PORT:'0',HOST:'127.0.0.1',NODE_ENV:'test',PEMS_ROSTER:roster,PEMS_OUTPUT:output,
      PEMS_BLOB_ENDPOINT:'',PEMS_BLOB_CONTAINER:'',PEMS_ORIGIN:''}
  });
  try{
    const [chunk]=await Promise.race([
      once(server.stdout,'data'),
      once(server,'exit').then(([code])=>{throw new Error('Server exited with '+code);})
    ]);
    const port=String(chunk).match(/port (\d+)/)?.[1];
    assert.ok(port);
    const origin='http://127.0.0.1:'+port;
    const post=async(path,body,cookie='')=>{
      const res=await fetch(origin+path,{method:'POST',headers:{origin,cookie,'Content-Type':'application/json'},
        body:JSON.stringify(body)});
      return {status:res.status,json:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};
    };
    const html=await (await fetch(origin)).text();
    assert.doesNotMatch(html,/Nora, Training|000000000000003/);
    assert.equal((await fetch(origin+'/fixtures/candidates.csv')).status,404);
    assert.match(html,/Enter all 15 digits without dashes/);
    for(const emiratesId of ['123', '0000000000000001', '00000000000000X']){
      const invalid=await post('/api/login',{emiratesId});
      assert.equal(invalid.status,400);
      assert.match(invalid.json.error,/exactly 15 digits/);
    }
    const missing=await post('/api/login',{emiratesId:'000000000000009'});
    assert.equal(missing.status,401);
    assert.match(missing.json.error,/not found on the assessment roster/);
    assert.equal((await post('/api/submissions',{})).status,401);
    const first=await post('/api/login',{emiratesId:'000-0000-0000000-3'});
    assert.equal(first.status,200);
    assert.equal(first.json.name,'Nora, Training');
    const second=await post('/api/login',{emiratesId:'000000000000004'});
    assert.notEqual(first.json.attempt,second.json.attempt);
    const body={attempt:first.json.attempt,records:[
      {id:1,kind:'exhibit',description:'Training bottle',time:'2026-11-24T08:00',recoveredBy:'Nora, Training',seal:'S-001'},
      {id:2,kind:'request',exhibit:1,description:'Arrange handover',specialism:'Trace',time:'2026-11-24T08:05'},
      {id:3,kind:'transfer',exhibit:1,from:'Nora',to:'Intake',time:'2026-11-24T08:10',ack:'Confirmed'},
      {id:4,kind:'video',exhibit:1,description:'Scene recording',filename:'scene.mp4',time:'2026-11-24T08:15'}
    ]};
    assert.equal((await post('/api/submissions',body,second.cookie)).status,409);
    const results=await Promise.all([post('/api/submissions',body,first.cookie),post('/api/submissions',body,first.cookie)]);
    assert.equal(results[0].status,200);
    assert.deepEqual(results[0].json,results[1].json);
    assert.deepEqual(await readdir(output),[results[0].json.filename]);
    const pdf=await readFile(join(output,results[0].json.filename));
    assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
    assert.equal((await fetch(origin+'/submissions/'+results[0].json.filename)).status,404);
    await post('/api/logout',{},first.cookie);
    assert.equal((await post('/api/submissions',body,first.cookie)).status,401);
  }finally{
    if(server.exitCode===null){const stopped=once(server,'exit');server.kill();await stopped;}
    await rm(directory,{recursive:true,force:true});
  }
});
