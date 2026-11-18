import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createServer } from '../scripts/serve.mjs';

// Invoke the actual HTTP request handler without opening a prohibited local socket.
async function serve(path, method='GET') {
  const server=createServer();
  return new Promise(resolve=>server.emit('request',{url:path,method},{
    writeHead(status,headers){this.status=status;this.headers=headers;},
    end(body){resolve({status:this.status,headers:this.headers,body:body?.toString('utf8')});}
  }));
}
test('SW調査: 実配信ハンドラーがsw.jsとimportScripts先をJS・no-cacheで返し評価できる',async()=>{
  const script=await serve('/sw.js'),inventory=await serve('/precache.js');
  for(const response of [script,inventory]){
    assert.equal(response.status,200);assert.match(response.headers['Content-Type'],/^text\/javascript/);
    assert.equal(response.headers['Cache-Control'],'no-cache');assert.equal(response.headers['X-Content-Type-Options'],'nosniff');
  }
  assert.equal((await serve('/sw.js','HEAD')).body,undefined);
  const registered=[],imported=[],context={self:{addEventListener:name=>registered.push(name)},importScripts:path=>{
    imported.push(path);assert.equal(path,'./precache.js');vm.runInContext(inventory.body,context);
  }};
  vm.createContext(context);vm.runInContext(script.body,context);
  assert.deepEqual(imported,['./precache.js']);assert.deepEqual(registered,['install','activate','fetch']);
  for(const path of context.self.PRECACHE){const response=await serve(new URL(path,'http://127.0.0.1/').pathname);assert.equal(response.status,200,path);}
});
