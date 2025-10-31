// 🚀 120行实现：缓存 + 转换 + 20+模型
const MODELS = Object.fromEntries(MODELS.trim().split("\n").map(l => { 
  const [m,p,u] = l.split("|"); 
  return [m,{provider:p,url:u}]; 
}));

export default {
  async fetch(r,env) {
    if (r.method==="OPTIONS") return new Response("",{status:204,headers:cors()});
    if (new URL(r.url).pathname!=='/v1/chat/completions') return new Response("404",{status:404});
    
    const {model,messages,stream=false,...rest}=await r.json().catch(()=>null)||{};
    if(!model||!messages) return json({error:"Missing model/messages"},400);
    
    const route=MODELS[model];
    if(!route) return json({error:`Model ${model} not supported`},400);
    
    const key=hdr(r,"x-api-key")||hdr(r,"authorization");
    if(!key) return json({error:"Missing API Key"},401);
    
    const hash=await sha256(JSON.stringify({model,messages}));
    const ck=`c:${hash}`;
    
    if(!stream){
      const cached=await env.KV.get(ck);
      if(cached) return new Response(cached,{headers:jsonHdr()});
    }
    
    const req=build(route,key,{model,messages,stream,...rest});
    const res=await fetch(req);
    
    const h=new Headers(res.headers); clean(h); cors(h);
    
    if(!stream){
      let d=await res.json();
      if(route.provider==="anthropic") d=toOpenAI(d,model);
      const t=JSON.stringify(d);
      env.KV.put(ck,t,{expirationTtl:86400});
      return new Response(t,{headers:h});
    }
    
    return new Response(res.body.pipeThrough(streamTransform(route.provider,model,env.KV,ck)),{headers:h});
  }
};

// 🎯 工具函数（30行）
const hdr=(r,h)=>r.headers.get(h)?.replace(/^Bearer\s+/i,"");
const json=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:jsonHdr()});
const cors=h=>({...h,"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"POST,OPTIONS","Access-Control-Allow-Headers":"*"});
const jsonHdr=()=>({...cors(),"Content-Type":"application/json"});
const clean=h=>["set-cookie","x-ratelimit-"].forEach(p=>[...h.keys()].filter(k=>k.startsWith(p)).forEach(k=>h.delete(k)));
const sha256=async s=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s)))).map(b=>b.toString(16).padStart(2,"0")).join("");

// 🎯 请求构建（30行）
const build=(route,key,body)=>{
  const {model,messages,stream,...rest}=body;
  let u=route.url,h={"Content-Type":"application/json"};
  
  let p;
  if(route.provider==="anthropic"){
    h["x-api-version"]="2023-06-01";
    const sys=messages.find(m=>m.role==="system")?.content;
    p={model,stream,max_tokens:rest.max_tokens||1024,messages:messages.filter(m=>m.role!=="system").map(m=>({role:m.role==="assistant"?"assistant":"user",content:m.content})),...(sys&&{system:sys})};
  }else if(route.provider==="gemini"){
    u+=`?key=${key}`; p={contents:messages.map(m=>({role:m.role==="assistant"?"model":"user",parts:[{text:m.content}]}))};
  }else{
    h.Authorization=`Bearer ${key}`; p={model,messages,stream,...rest};
  }
  
  return new Request(u,{method:"POST",headers:h,body:JSON.stringify(p)});
};

// 🎯 响应转换（30行）
const toOpenAI=(d,m)=>({
  id:d.id||"chatcmpl-"+Date.now(),
  object:"chat.completion",created:Date.now()/1000,model:m,
  choices:[{index:0,message:{role:"assistant",content:d.content?.[0]?.text||""},finish_reason:"stop"}]
});

const streamTransform=(provider,model,kv,ck)=>{
  const e=new TextEncoder(),b="",c="";
  return new TransformStream({
    transform(cn,ctrl){
      b+=new TextDecoder().decode(cn,{stream:true});
      b.split("\n").slice(0,-1).forEach(l=>{
        if(provider==="anthropic"&&l.startsWith("data: ")){
          try{
            const d=JSON.parse(l.slice(6));
            if(d.delta?.text){
              c+=d.delta.text;
              ctrl.enqueue(e.encode(`data: ${JSON.stringify({id:d.message_id,object:"chat.completion.chunk",model,choices:[{index:0,delta:{content:d.delta.text}}]} )}\n\n`));
            }
            if(d.type==="message_stop"){
              ctrl.enqueue(e.encode(`data: ${JSON.stringify({id:d.message_id,object:"chat.completion.chunk",model,choices:[{index:0,delta:{},finish_reason:"stop"}]} )}\n\ndata: [DONE]\n\n`));
              kv.put(ck,JSON.stringify(toOpenAI({content:[{text:c}]},model)),{expirationTtl:86400});
            }
          }catch{}
        }else ctrl.enqueue(e.encode(l+"\n"));
      });
      b=b.split("\n").pop()||"";
    }
  });
};
