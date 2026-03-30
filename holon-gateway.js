export default {
  async fetch(req) {
    const p = new URL(req.url).pathname;
    const U='https://fresh-walleye-84119.upstash.io';
    const T='gQAAAAAAAUiXAAIncDEwMjljNTI2ZGQ5OWQ0OGJlOTFmYWU2YjQ2OGI0NmIyZXAxODQxMTk';
    const H={'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
    const J=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:H});
    
    if(p==='/health'||p==='/ping')return J({ok:true,service:'holon-gateway-v1',ts:new Date().toISOString()});
    
    if(p==='/join'){
      const ip=req.headers.get('CF-Connecting-IP')||'unknown';
      const country=req.headers.get('CF-IPCountry')||'?';
      try{
        await fetch(`${U}/incr/holon%3Anodes%3Atotal`,{method:'POST',headers:{Authorization:`Bearer ${T}`}});
        await fetch(`${U}/lpush/holon%3Anodes%3Alist/${encodeURIComponent(JSON.stringify({ip,country,ts:new Date().toISOString()}))}`,{method:'POST',headers:{Authorization:`Bearer ${T}`}});
      }catch{}
      return J({ok:true,joined:true,welcome:'Holon network node registered'});
    }
    
    if(p==='/nodes'){
      try{
        const r=await fetch(`${U}/get/holon%3Anodes%3Atotal`,{headers:{Authorization:`Bearer ${T}`}});
        const d=await r.json();
        return J({ok:true,total:parseInt(d.result)||1});
      }catch{return J({ok:true,total:1});}
    }
    
    return J({service:'holon-gateway-v1',endpoints:['/ping','/join','/nodes']});
  }
}
