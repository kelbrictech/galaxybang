const cors = {
  "Access-Control-Allow-Origin": "https://galaxybang.pages.dev",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};
function json(data, status=200) {
  return new Response(JSON.stringify(data), {status, headers:{"Content-Type":"application/json",...cors}});
}
function code() {
  const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes=crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes,b=>chars[b%chars.length]).join("");
}
export default {
  async fetch(request, env) {
    if (request.method==="OPTIONS") return new Response(null,{headers:cors});
    const url=new URL(request.url);
    if (url.pathname==="/health") return json({ok:true,service:"galaxybang-remote"});
    if (url.pathname==="/room/create" && request.method==="POST") {
      const body=await request.json().catch(()=>({}));
      const players=Math.max(2,Math.min(4,Number(body.players)||2));
      const board=body.board==="small"?"small":"standard";
      let roomCode, id;
      for(let i=0;i<8;i++){
        roomCode=code(); id=env.ROOMS.idFromName(roomCode);
        const stub=env.ROOMS.get(id);
        const result=await stub.fetch("https://room/init",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({players,board,code:roomCode})});
        if(result.status===201) return json(await result.json(),201);
      }
      return json({error:"Could not create a room. Try again."},503);
    }
    const match=url.pathname.match(/^\/room\/([A-Z0-9]{6})(?:\/(join|state|start|move|restart))?$/);
    if(!match) return json({error:"Not found"},404);
    const roomCode=match[1], action=match[2]||"state";
    const stub=env.ROOMS.get(env.ROOMS.idFromName(roomCode));
    const proxied=await stub.fetch(new Request("https://room/"+action+url.search,{method:request.method,headers:request.headers,body:request.method==="GET"||request.method==="HEAD"?undefined:request.body}));\n    return new Response(proxied.body,{status:proxied.status,headers:{...Object.fromEntries(proxied.headers),...cors}});
  }
};
const PLAYERS=4;
const dims=board=>board==="small"?{cols:6,rows:8}:{cols:9,rows:12};
function critical(r,c,rows,cols){return (r>0)+(r<rows-1)+(c>0)+(c<cols-1);}
function neighbors(r,c,rows,cols){
 const a=[]; if(r>0)a.push([r-1,c]); if(r<rows-1)a.push([r+1,c]); if(c>0)a.push([r,c-1]); if(c<cols-1)a.push([r,c+1]); return a;
}
function initial(players,board){
 const {cols,rows}=dims(board);
 return {code:null,players,board,cols,rows,seats:[],started:false,owner:Array.from({length:rows},()=>Array(cols).fill(-1)),count:Array.from({length:rows},()=>Array(cols).fill(0)),current:0,hasPlayed:Array(PLAYERS).fill(false),eliminated:Array(PLAYERS).fill(true),winner:-1,moveCount:0,created:Date.now()};
}
function snapshot(s,seat){
 return {code:s.code,players:s.seats.map(x=>({name:["Red","Blue","Green","Yellow"][x.color],color:x.color,host:x.host,connected:true})),targetPlayers:s.players,board:s.board,cols:s.cols,rows:s.rows,started:s.started,owner:s.owner,count:s.count,current:s.current,eliminated:s.eliminated,winner:s.winner,moveCount:s.moveCount,myColor:seat.color,isHost:seat.host,seats:s.seats.length};
}
export class Room {
 constructor(ctx,env){this.ctx=ctx;this.env=env;}
 async fetch(request){
  const url=new URL(request.url), action=url.pathname.split("/").pop();
  if(action==="init" && request.method==="POST"){
   const old=await this.ctx.storage.get("state"); if(old)return new Response("exists",{status:409});
   const b=await request.json(); const s=initial(b.players,b.board); s.code=b.code;
   const token=crypto.randomUUID(); s.seats=[{token,color:0,host:true}]; s.eliminated[0]=false;
   await this.ctx.storage.put("state",s);
   return Response.json({code:s.code,token,color:0,isHost:true,state:snapshot(s,{color:0,host:true})},{status:201});
  }
  let s=await this.ctx.storage.get("state");
  if(!s)return Response.json({error:"Room not found or expired."},{status:404});
  if(action==="join" && request.method==="POST"){
   if(s.started)return Response.json({error:"Game already started."},{status:409});
   if(s.seats.length>=s.players)return Response.json({error:"Room is full."},{status:409});
   const body=await request.json(), token=crypto.randomUUID(), color=s.seats.length;
   s.seats.push({token,color,host:false}); s.eliminated[color]=false;
   await this.ctx.storage.put("state",s);
   return Response.json({code:s.code,token,color,isHost:false,state:snapshot(s,{color,host:false})});
  }
  const token=url.searchParams.get("token");
  const seat=s.seats.find(x=>x.token===token);
  if(!seat)return Response.json({error:"Invalid room access token."},{status:401});
  if(action==="state" && request.method==="GET")return Response.json(snapshot(s,seat));
  if(action==="start" && request.method==="POST"){
   if(!seat.host)return Response.json({error:"Only the host can start."},{status:403});
   if(s.seats.length<2)return Response.json({error:"At least two players must join."},{status:409});
   s.players=s.seats.length; s.started=true; s.current=s.seats[0].color;
   s.eliminated=Array(PLAYERS).fill(true); s.hasPlayed=Array(PLAYERS).fill(false);
   for(const p of s.seats)s.eliminated[p.color]=false;
   await this.ctx.storage.put("state",s); return Response.json(snapshot(s,seat));
  }
  if(action==="restart" && request.method==="POST"){
   if(!seat.host)return Response.json({error:"Only the host can restart."},{status:403});
   const fresh=initial(s.players,s.board); fresh.code=s.code; fresh.seats=s.seats; fresh.started=true;
   for(const p of fresh.seats)fresh.eliminated[p.color]=false;
   s=fresh; await this.ctx.storage.put("state",s); return Response.json(snapshot(s,seat));
  }
  if(action==="move" && request.method==="POST"){
   if(!s.started)return Response.json({error:"Game has not started."},{status:409});
   if(s.winner!==-1)return Response.json({error:"Game is over."},{status:409});
   if(seat.color!==s.current)return Response.json({error:"It is not your turn."},{status:403});
   const {row,col}=await request.json();
   if(!Number.isInteger(row)||!Number.isInteger(col)||row<0||row>=s.rows||col<0||col>=s.cols)return Response.json({error:"Invalid tile."},{status:400});
   const o=s.owner[row][col]; if(o!==-1&&o!==seat.color)return Response.json({error:"That tile belongs to another player."},{status:409});
   s.hasPlayed[seat.color]=true; s.moveCount++;
   if(o===-1){s.owner[row][col]=seat.color;s.count[row][col]=1;}else s.count[row][col]++;
   for(let wave=0;wave<200;wave++){
    const blowing=[];
    for(let r=0;r<s.rows;r++)for(let c=0;c<s.cols;c++)if(s.count[r][c]>=critical(r,c,s.rows,s.cols))blowing.push([r,c,s.owner[r][c]]);
    if(!blowing.length)break;
    const gains=[];
    for(const [r,c,p] of blowing){
     for(const [nr,nc] of neighbors(r,c,s.rows,s.cols))gains.push([nr,nc,p]);
     s.owner[r][c]=-1;s.count[r][c]=0;
    }
    for(const [r,c,p] of gains){s.owner[r][c]=p;s.count[r][c]++;}
   }
   for(const p of s.seats.map(x=>x.color)){
    if(!s.eliminated[p]&&s.hasPlayed[p]){
     let tiles=0; for(let r=0;r<s.rows;r++)for(let c=0;c<s.cols;c++)if(s.owner[r][c]===p)tiles++;
     if(tiles===0)s.eliminated[p]=true;
    }
   }
   const alive=s.seats.map(x=>x.color).filter(p=>!s.eliminated[p]);
   if(alive.length===1)s.winner=alive[0];
   if(s.winner===-1){
    const order=s.seats.map(x=>x.color),idx=order.indexOf(s.current);
    for(let n=1;n<=order.length;n++){const p=order[(idx+n)%order.length];if(!s.eliminated[p]){s.current=p;break;}}
   }
   await this.ctx.storage.put("state",s); return Response.json(snapshot(s,seat));
  }
  return Response.json({error:"Unsupported action."},{status:404});
 }
}
