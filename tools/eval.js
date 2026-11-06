const fs=require('fs'),http=require('http');
const expr = process.argv[2] || 'document.body.innerText.slice(0,300)';
http.get('http://127.0.0.1:9222/json/list', r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>{
  const t=JSON.parse(b).find(x=>x.type==='page');
  const ws=new WebSocket(t.webSocketDebuggerUrl); let id=0; const p=new Map();
  const send=(m,q={})=>new Promise(res=>{const i=++id;p.set(i,res);ws.send(JSON.stringify({id:i,method:m,params:q}))});
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data); if(m.id&&p.has(m.id)){p.get(m.id)(m.result);p.delete(m.id)}});
  ws.addEventListener('open',async()=>{
    const r2=await send('Runtime.evaluate',{expression:expr,returnByValue:true});
    console.log(typeof r2.result.value==='string'?r2.result.value:JSON.stringify(r2.result.value,null,1));
    ws.close(); process.exit(0);
  });
})}).on('error',e=>{console.error(e);process.exit(1)});
