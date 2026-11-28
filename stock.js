// Stock management: Godown (back store) + Counter (pharmacy shelf).
// Every change is an append-only "move" (ledger). Balances live in users/{uid}/stock/{medicineId}
// and are changed with Firestore increment() inside a transaction, so two devices can work
// together and a retried upload is never applied twice.
//
// Quantities are stored in the unit the BILL sells (e.g. tablets). The person types and sees
// stock in the pack unit of that medicine (Box, Bottle, Strip...), plus loose items if any.

const TYPE_LABEL={receive:"Stock received",transfer:"Moved to counter",sale:"Sold (bill)",refund:"Refund return",count:"Count correction",setup:"Opening stock"};
const UNIT_GUESS={tablet:["Box",10],capsule:["Box",10],strip:["Box",10],syrup:["Bottle",1],injection:["Vial",1],suspension:["Bottle",1],drops:["Bottle",1],cream:["Tube",1],ointment:["Tube",1],piece:["Piece",1],box:["Box",1],bottle:["Bottle",1]};
const r3=n=>Math.round((Number(n)||0)*1000)/1000;
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

export function createStock(ctx){
 const {$,notify,openAppModal,closeAppModal,confirmAction}=ctx;
 let uid=null,dbRef=null,cloud=new Map(),pending=[],ledger=new Map(),unsubStock=null,unsubLedger=null,filter="all",term="",started=false;

 // ---------- state ----------
 const cfgOf=id=>{const c=cloud.get(id)?.cfg;return c&&c.on&&Array.isArray(c.lines)&&c.lines.length?c:null;};
 const saleLine=c=>c.lines.find(l=>l.id===c.saleLine)||c.lines[0];
 function balance(medId,lineId){
  const b=cloud.get(medId)?.lines?.[lineId]||{};let c=Number(b.c)||0,g=Number(b.g)||0;
  for(const m of pending)if(m.medicineId===medId&&m.lineId===lineId){c+=Number(m.dc)||0;g+=Number(m.dg)||0;}
  return {c:r3(c),g:r3(g)};
 }
 function fmt(base,line){
  const per=Math.max(1,Number(line.per)||1),label=String(line.label||"unit").toLowerCase(),a=Math.abs(base),sign=base<0?"-":"";
  if(per<=1)return sign+r3(a)+" "+label;
  const b=Math.floor(a/per+1e-9),rest=r3(a-b*per);
  return sign+b+" "+label+(rest?" + "+rest:"");
 }
 function statusOf(id){
  const c=cfgOf(id);if(!c)return {key:"none",text:"Not set"};
  let out=false,low=false,refill=false;
  for(const l of c.lines){const b=balance(id,l.id),tot=b.c+b.g;if(tot<=0)out=true;else if(Number(c.low)>0&&tot<=Number(c.low)*l.per)low=true;if(b.c<=0&&b.g>0)refill=true;}
  if(out)return {key:"out",text:"Out"};if(low)return {key:"low",text:"Low"};if(refill)return {key:"refill",text:"Refill counter"};return {key:"ok",text:"OK"};
 }
 const meds=()=>(ctx.medicines()||[]).filter(m=>m&&m.id&&m.name).slice().sort((a,b)=>String(a.name).localeCompare(String(b.name)));
 const medById=id=>(ctx.medicines()||[]).find(m=>m.id===id);

 async function loadPending(){
  if(!dbRef)return;
  try{pending=(await dbRef.getAll("pending",IDBKeyRange.bound("stockMoves:","stockMoves:￿"))).map(j=>j.data).filter(Boolean);}catch(e){console.warn("stock pending",e);}
 }
 async function refresh(){await loadPending();render();}

 // ---------- cloud ----------
 async function start(userId,db){
  uid=userId;dbRef=db;cloud=new Map();pending=[];ledger=new Map();
  try{for(const row of await dbRef.getAll("stock"))cloud.set(row.id,row);}catch(e){}
  await loadPending();render();
  if(unsubStock)unsubStock();
  unsubStock=ctx.onSnapshot(ctx.collection(ctx.db,"users",uid,"stock"),snap=>{
   if(ctx.uid()!==uid||ctx.localDB()!==dbRef)return;
   snap.docChanges().forEach(ch=>{const id=ch.doc.id;if(ch.type==="removed"){cloud.delete(id);dbRef.delete("stock",id).catch(()=>{});}else{const row={id,...ch.doc.data()};cloud.set(id,row);dbRef.put("stock",row).catch(()=>{});}});
   render();
  },err=>console.warn("stock listener:",err?.code||err));
  startLedger();
 }
 function startLedger(){
  if(unsubLedger||!uid)return;
  const since=Date.now()-3*86400000;
  try{unsubLedger=ctx.onSnapshot(ctx.query(ctx.collection(ctx.db,"users",uid,"stockMoves"),ctx.where("createdAtMillis",">=",since)),snap=>{snap.docs.forEach(d=>ledger.set(d.id,{id:d.id,...d.data()}));},err=>console.warn("stock ledger:",err?.code||err));}catch(e){console.warn(e);}
 }
 function stop(){if(unsubStock)unsubStock();if(unsubLedger)unsubLedger();unsubStock=unsubLedger=null;uid=null;dbRef=null;cloud=new Map();pending=[];ledger=new Map();}

 // Called from the sync queue
 async function syncMove(job,ownerUid){
  const m=job.data,moveRef=ctx.doc(ctx.db,"users",ownerUid,"stockMoves",job.targetId),balRef=ctx.doc(ctx.db,"users",ownerUid,"stock",m.medicineId);
  await ctx.runTransaction(ctx.db,async tx=>{
   const s=await tx.get(moveRef);if(s.exists())return;
   tx.set(moveRef,m);
   const line={};if(m.dc)line.c=ctx.increment(m.dc);if(m.dg)line.g=ctx.increment(m.dg);
   tx.set(balRef,{lines:{[m.lineId]:line},updatedAt:Date.now()},{merge:true});
  });
 }
 async function syncConfig(job,ownerUid){
  await ctx.setDoc(ctx.doc(ctx.db,"users",ownerUid,"stock",job.targetId),{cfg:job.data,updatedAt:Date.now()},{merge:true});
 }

 // ---------- writing ----------
 async function addMove(m){
  const move={id:"mv-"+Date.now().toString(36)+"-"+crypto.randomUUID().slice(0,8),createdAtMillis:Date.now(),dc:0,dg:0,...m};
  move.dc=r3(move.dc);move.dg=r3(move.dg);
  if(!move.dc&&!move.dg)return null;
  await ctx.queue(move.id,"move",move,"stockMoves");pending.push(move);return move;
 }
 async function saveConfig(medId,cfg){
  const next={...cfg,on:true,updatedAt:Date.now()};
  await ctx.queue(medId,"set",next,"stock");
  const cur=cloud.get(medId)||{id:medId,lines:{}};cloud.set(medId,{...cur,cfg:next});
  dbRef?.put("stock",cloud.get(medId)).catch(()=>{});
 }
 const flushSoon=()=>{if(navigator.onLine)ctx.flush().then(()=>refresh()).catch(e=>console.warn("stock sync pending",e));else refresh();};

 // ---------- bills ----------
 // Returns {medicineId: units} for tracked medicines (positive = taken from counter).
 function billEffect(items,kind="sale"){
  const out={};
  for(const it of items||[]){
   if(!it||it.kind==="custom"||!it.medicineId)continue;if(!cfgOf(it.medicineId))continue;
   const q=(kind==="refund-in"?-1:1)*(Number(it.quantity)||0);out[it.medicineId]=r3((out[it.medicineId]||0)+q);
  }
  return out;
 }
 function refundEffect(tx){
  const a=billEffect(tx.newItems,"sale"),b=billEffect(tx.refundItems,"refund-in"),out={};
  for(const k of new Set([...Object.keys(a),...Object.keys(b)]))out[k]=r3((a[k]||0)+(b[k]||0));
  return out;
 }
 async function applyBillChange(billId,prev,next,label){
  const p=prev||{},n=next||{},low=[];
  for(const id of new Set([...Object.keys(p),...Object.keys(n)])){
   const diff=r3((n[id]||0)-(p[id]||0));if(!diff)continue;const c=cfgOf(id);if(!c)continue;
   await addMove({type:diff<0?"refund":"sale",medicineId:id,lineId:saleLine(c).id,dc:-diff,name:medById(id)?.name||"",refId:billId,note:label||""});
   if(diff>0){const b=balance(id,saleLine(c).id);if(b.c<=0)low.push(medById(id)?.name||"medicine");}
  }
  render();flushSoon();
  if(low.length)notify("Counter stock finished: "+low.slice(0,3).join(", ")+(low.length>3?" +"+(low.length-3):"")+" — move more from godown.","warning",6500);
 }

 // ---------- UI helpers ----------
 const el=(tag,cls,html)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(html!=null)n.innerHTML=html;return n;};
 const timeText=ms=>{const d=new Date(ms);return d.toLocaleDateString([],{day:"2-digit",month:"short"})+" "+d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});};
 const needEdit=()=>{if(ctx.editMode())return true;notify("Turn on Medicine Edit Mode in Settings first.","warning",4800);return false;};
 function guess(m){const k=String(m.unit||"").toLowerCase();const g=UNIT_GUESS[k]||["Box",1];return {unit:g[0],per:g[1]};}

 // ---------- page ----------
 function render(){
  const list=$("stockList");if(!list)return;
  const all=meds();
  const order={out:0,low:1,refill:2,ok:3,none:4};
  const rows=all.map(m=>({m,c:cfgOf(m.id),s:statusOf(m.id)})).sort((a,b)=>(order[a.s.key]-order[b.s.key])||String(a.m.name).localeCompare(String(b.m.name)));
  const count=k=>rows.filter(r=>r.s.key===k).length;
  const sum=$("stockSummary");
  if(sum){sum.innerHTML="";[["Tracked",rows.filter(r=>r.c).length+"/"+rows.length,"all"],["Low",count("low"),"low"],["Out",count("out"),"out"],["Refill",count("refill"),"refill"]].forEach(([t,v,f])=>{const b=el("button","stk-tile"+(filter===f&&f!=="all"?" active":""),"<strong>"+esc(v)+"</strong><small>"+esc(t)+"</small>");b.type="button";b.onclick=()=>{filter=filter===f?"all":f;render();};sum.append(b);});}
  document.querySelectorAll("#stockFilters .stk-chip").forEach(b=>b.classList.toggle("active",b.dataset.f===filter));
  const q=term.trim().toLowerCase();
  const shown=rows.filter(r=>(!q||String(r.m.name).toLowerCase().includes(q)||(r.m.tags||[]).some(t=>String(t).toLowerCase().includes(q)))&&(filter==="all"||(filter==="none"?!r.c:filter==="tracked"?!!r.c:r.s.key===filter)));
  list.replaceChildren();
  if(!shown.length){list.append(el("p","stk-empty",all.length?"No medicines match this filter.":"Add medicines first."));return;}
  for(const r of shown){
   const card=el("button","stk-card "+r.s.key);card.type="button";
   const head=el("div","stk-head","<b>"+esc(r.m.name)+"</b><span class='stk-badge "+r.s.key+"'>"+esc(r.s.text)+"</span>");card.append(head);
   if(!r.c){card.append(el("div","stk-none","Tap to set up stock"));}
   else for(const l of r.c.lines){
    const b=balance(r.m.id,l.id);
    const row=el("div","stk-cols");
    if(r.c.lines.length>1)row.append(el("div","stk-line",esc(l.label)));
    row.append(el("div","","<small>Counter</small><strong class='"+(b.c<0?"neg":"")+"'>"+esc(fmt(b.c,l))+"</strong>"),el("div","","<small>Godown</small><strong class='"+(b.g<0?"neg":"")+"'>"+esc(fmt(b.g,l))+"</strong>"),el("div","","<small>Total</small><strong>"+esc(fmt(r.c?b.c+b.g:0,l))+"</strong>"));
    card.append(row);
   }
   card.onclick=()=>r.c?sheet(r.m.id):setupForm(r.m.id);
   list.append(card);
  }
 }

 // ---------- sheets ----------
 function balanceBlock(medId){
  const c=cfgOf(medId),box=el("div","stk-bal");
  if(!c)return box;
  for(const l of c.lines){const b=balance(medId,l.id);box.append(el("div","stk-bal-row",(c.lines.length>1?"<span class='stk-line'>"+esc(l.label)+"</span>":"")+"<span>Counter <b>"+esc(fmt(b.c,l))+"</b></span><span>Godown <b>"+esc(fmt(b.g,l))+"</b></span>"));}
  return box;
 }
 function sheet(medId){
  const m=medById(medId),c=cfgOf(medId);if(!m||!c)return;
  const node=el("div","stk-sheet");node.append(balanceBlock(medId));
  const grid=el("div","stk-actions");
  const mk=(icon,title,sub,fn)=>{const b=el("button","stk-action","<span class='stk-ico'>"+icon+"</span><span><b>"+esc(title)+"</b><small>"+esc(sub)+"</small></span>");b.type="button";b.onclick=fn;grid.append(b);};
  mk("＋","Receive stock","New delivery → godown",()=>qtyForm(medId,"receive"));
  mk("→","Move to counter","Godown → shelf",()=>qtyForm(medId,"transfer"));
  mk("✓","Correct count","Enter the real count",()=>countForm(medId));
  mk("⚙","Setup","Pack size, low alert",()=>setupForm(medId));
  node.append(grid);
  const hist=el("button","secondary stk-wide","Recent history");hist.type="button";hist.onclick=()=>historySheet(medId);node.append(hist);
  openAppModal(node,m.name,"Stock · Counter and Godown");
 }
 function lineSelect(c){
  if(c.lines.length<2)return {node:null,get:()=>c.lines[0]};
  const wrap=el("label","stk-field","<span>Pack</span>");const sel=document.createElement("select");
  c.lines.forEach(l=>{const o=document.createElement("option");o.value=l.id;o.textContent=l.label;sel.append(o);});wrap.append(sel);
  return {node:wrap,get:()=>c.lines.find(l=>l.id===sel.value)||c.lines[0],sel};
 }
 function qtyInputs(per,label){
  const wrap=el("div","stk-qty");
  const a=el("label","stk-field","<span>"+esc(label)+"</span>"),boxes=document.createElement("input");boxes.type="number";boxes.min="0";boxes.step="any";boxes.inputMode="decimal";boxes.placeholder="0";boxes.name="stockBoxes";boxes.setAttribute("aria-label",label);a.append(boxes);wrap.append(a);
  let loose=null;
  if(per>1){const b=el("label","stk-field","<span>Loose</span>");loose=document.createElement("input");loose.type="number";loose.min="0";loose.step="any";loose.inputMode="decimal";loose.placeholder="0";loose.name="stockLoose";loose.setAttribute("aria-label","Loose items");b.append(loose);wrap.append(b);}
  return {node:wrap,boxes,loose,base:per2=>r3((Number(boxes.value)||0)*per2+(Number(loose?.value)||0))};
 }
 function qtyForm(medId,mode){
  const m=medById(medId),c=cfgOf(medId);if(!m||!c)return;
  const node=el("form","stk-form");node.noValidate=true;
  node.append(balanceBlock(medId));
  const sel=lineSelect(c);if(sel.node)node.append(sel.node);
  const line0=()=>sel.get();
  const inputs=qtyInputs(line0().per,line0().label);node.append(inputs.node);
  if(sel.sel)sel.sel.onchange=()=>{const l=line0();inputs.boxes.previousElementSibling.textContent=l.label;};
  const note=el("label","stk-field","<span>Note (optional)</span>"),ni=document.createElement("input");ni.name="stockNote";ni.setAttribute("aria-label","Note");ni.placeholder=mode==="receive"?"Supplier / invoice":"e.g. morning refill";note.append(ni);node.append(note);
  const warn=el("p","stk-warn");node.append(warn);
  const act=el("div","stk-buttons");const cancel=el("button","secondary","Cancel");cancel.type="button";cancel.onclick=()=>sheet(medId);
  const save=el("button","primary",mode==="receive"?"Add to godown":"Move to counter");save.type="submit";act.append(cancel,save);node.append(act);
  const check=()=>{if(mode!=="transfer"){warn.textContent="";return;}const l=line0(),b=balance(medId,l.id),need=inputs.base(l.per);warn.textContent=need>b.g?"Godown has only "+fmt(b.g,l)+". Counter will still be updated.":"";};
  node.addEventListener("input",check);
  node.onsubmit=async e=>{
   e.preventDefault();const l=line0(),qty=inputs.base(l.per);
   if(!(qty>0)){notify("Enter a quantity.","warning");inputs.boxes.focus();return;}
   save.disabled=true;
   try{
    if(mode==="receive")await addMove({type:"receive",medicineId:medId,lineId:l.id,dg:qty,name:m.name,note:ni.value.trim()});
    else await addMove({type:"transfer",medicineId:medId,lineId:l.id,dg:-qty,dc:qty,name:m.name,note:ni.value.trim()});
    closeAppModal();render();flushSoon();notify((mode==="receive"?"Received: ":"Moved to counter: ")+fmt(qty,l)+" · "+m.name,"success",3200);
   }catch(err){console.error(err);notify("Could not save: "+(err?.message||"error"),"error");save.disabled=false;}
  };
  openAppModal(node,m.name,mode==="receive"?"Receive stock into godown":"Move stock from godown to counter");
  setTimeout(()=>inputs.boxes.focus(),80);
 }
 function countForm(medId){
  if(!needEdit())return;
  const m=medById(medId),c=cfgOf(medId);if(!m||!c)return;
  const node=el("form","stk-form");node.noValidate=true;
  node.append(el("p","muted small-text","Enter what you really counted now. The difference is saved as a correction."));
  const fields=c.lines.map(l=>{
   const b=balance(medId,l.id),box=el("div","stk-count");
   if(c.lines.length>1)box.append(el("div","stk-line",esc(l.label)));
   const cc=qtyInputs(l.per,"Counter ("+String(l.label).toLowerCase()+")"),gg=qtyInputs(l.per,"Godown ("+String(l.label).toLowerCase()+")");
   const setVals=(inp,base)=>{const per=Math.max(1,l.per);const bx=Math.floor(Math.abs(base)/per+1e-9)*(base<0?-1:1);inp.boxes.value=String(bx);if(inp.loose)inp.loose.value=String(r3(base-bx*per));};
   setVals(cc,b.c);setVals(gg,b.g);box.append(cc.node,gg.node);node.append(box);
   return {l,b,cc,gg};
  });
  const note=el("label","stk-field","<span>Reason (optional)</span>"),ni=document.createElement("input");ni.name="stockReason";ni.setAttribute("aria-label","Reason");ni.placeholder="e.g. damaged, expired, recount";note.append(ni);node.append(note);
  const act=el("div","stk-buttons");const cancel=el("button","secondary","Cancel");cancel.type="button";cancel.onclick=()=>sheet(medId);const save=el("button","primary","Save count");save.type="submit";act.append(cancel,save);node.append(act);
  node.onsubmit=async e=>{
   e.preventDefault();save.disabled=true;let changed=0;
   try{for(const f of fields){const nc=f.cc.base(f.l.per),ng=f.gg.base(f.l.per);const dc=r3(nc-f.b.c),dg=r3(ng-f.b.g);if(dc||dg){await addMove({type:"count",medicineId:medId,lineId:f.l.id,dc,dg,name:m.name,note:ni.value.trim()});changed++;}}
    closeAppModal();render();flushSoon();notify(changed?"Count saved · "+m.name:"No difference — nothing changed.","success",3200);
   }catch(err){console.error(err);notify("Could not save: "+(err?.message||"error"),"error");save.disabled=false;}
  };
  openAppModal(node,m.name,"Correct count");
 }
 function setupForm(medId){
  if(!needEdit())return;
  const m=medById(medId);if(!m)return;
  const c=cfgOf(medId),g=guess(m);
  const lines=(c?c.lines:[{id:"main",label:g.unit,per:g.per}]).map(l=>({...l}));
  let sale=c?c.saleLine:lines[0].id;
  const node=el("form","stk-form");node.noValidate=true;
  node.append(el("p","muted small-text","Stock is kept in the pack unit (Box, Bottle…). “Items per pack” = how many <b>"+esc(m.unit||"units")+"</b> (as sold in billing) are in one pack. Use 1 if billing already sells the whole pack. Add a second pack only if the same medicine comes in two sizes."));
  const holder=el("div","stk-lines");node.append(holder);
  const draw=()=>{
   holder.replaceChildren();
   lines.forEach((l,i)=>{
    const row=el("div","stk-line-row");
    const name=document.createElement("input");name.value=l.label;name.placeholder="Pack name (Box, Bottle…)";name.setAttribute("aria-label","Pack name");name.setAttribute("list","stkUnits");name.oninput=()=>{l.label=name.value;};
    const per=document.createElement("input");per.type="number";per.min="1";per.step="any";per.inputMode="decimal";per.value=String(l.per);per.setAttribute("aria-label","Items per pack");per.oninput=()=>{l.per=Math.max(1,Number(per.value)||1);};
    const f1=el("label","stk-field","<span>Pack</span>");f1.append(name);const f2=el("label","stk-field","<span>Items per pack</span>");f2.append(per);
    row.append(f1,f2);
    if(lines.length>1){const rm=el("button","stk-x","×");rm.type="button";rm.setAttribute("aria-label","Remove pack");rm.onclick=()=>{lines.splice(i,1);if(sale===l.id)sale=lines[0].id;draw();};row.append(rm);const rd=el("label","stk-radio","<input type='radio' name='saleLine'"+(sale===l.id?" checked":"")+"> Sold from this pack");rd.querySelector("input").onchange=()=>{sale=l.id;};row.append(rd);}
    holder.append(row);
   });
  };
  draw();
  const dl=document.createElement("datalist");dl.id="stkUnits";["Box","Bottle","Strip","Vial","Piece","Pack","Tube","Sachet"].forEach(u=>{const o=document.createElement("option");o.value=u;dl.append(o);});node.append(dl);
  const add=el("button","secondary stk-wide","+ Add another pack size");add.type="button";add.onclick=()=>{if(lines.length>=4)return;lines.push({id:"p"+Date.now().toString(36),label:"Box",per:g.per});draw();};node.append(add);
  const low=el("label","stk-field","<span>Low-stock alert (packs, total)</span>"),li=document.createElement("input");li.type="number";li.min="0";li.step="any";li.inputMode="decimal";li.value=String(c?.low??0);li.setAttribute("aria-label","Low stock alert");low.append(li);node.append(low);
  let opening=null;
  if(!c){node.append(el("h4","stk-sub","Opening stock (packs)"));const row=el("div","stk-qty");const mkIn=(lab,n)=>{const w=el("label","stk-field","<span>"+lab+"</span>"),inp=document.createElement("input");inp.type="number";inp.min="0";inp.step="any";inp.inputMode="decimal";inp.placeholder="0";inp.name=n;inp.setAttribute("aria-label",lab);w.append(inp);row.append(w);return inp;};opening={ai:mkIn("Counter now","openCounter"),bi:mkIn("Godown now","openGodown")};node.append(row);}
  const act=el("div","stk-buttons");const cancel=el("button","secondary","Cancel");cancel.type="button";cancel.onclick=()=>closeAppModal();const save=el("button","primary",c?"Save setup":"Start tracking");save.type="submit";act.append(cancel,save);node.append(act);
  node.onsubmit=async e=>{
   e.preventDefault();
   const clean=lines.map(l=>({id:l.id,label:String(l.label||"Box").trim()||"Box",per:Math.max(1,Number(l.per)||1)}));
   save.disabled=true;
   try{
    await saveConfig(medId,{lines:clean,saleLine:clean.some(l=>l.id===sale)?sale:clean[0].id,unit:clean[0].label,low:Math.max(0,Number(li.value)||0)});
    if(opening){const l=clean.find(x=>x.id===sale)||clean[0];const dc=r3((Number(opening.ai.value)||0)*l.per),dg=r3((Number(opening.bi.value)||0)*l.per);if(dc||dg)await addMove({type:"setup",medicineId:medId,lineId:l.id,dc,dg,name:m.name});}
    closeAppModal();render();flushSoon();notify("Stock setup saved · "+m.name,"success",3200);
   }catch(err){console.error(err);notify("Could not save: "+(err?.message||"error"),"error");save.disabled=false;}
  };
  openAppModal(node,m.name,c?"Stock setup":"Start tracking stock");
 }
 function allMoves(){
  const map=new Map(ledger);for(const m of pending)map.set(m.id,m);
  return [...map.values()].sort((a,b)=>(b.createdAtMillis||0)-(a.createdAtMillis||0));
 }
 function moveLine(mv,showName){
  const m=medById(mv.medicineId),c=cfgOf(mv.medicineId),l=c?(c.lines.find(x=>x.id===mv.lineId)||c.lines[0]):{label:"unit",per:1};
  const delta=mv.type==="transfer"?Math.abs(mv.dc):(Number(mv.dc)||0)+(Number(mv.dg)||0);
  const where=mv.type==="transfer"?"godown → counter":mv.type==="receive"?"godown":(Number(mv.dc)&&!Number(mv.dg))?"counter":(!Number(mv.dc)&&Number(mv.dg))?"godown":"";
  const row=el("div","stk-move");
  row.innerHTML="<div><b>"+esc(showName?(m?.name||mv.name||"Medicine"):(TYPE_LABEL[mv.type]||mv.type))+"</b><small>"+esc((showName?(TYPE_LABEL[mv.type]||mv.type)+" · ":"")+timeText(mv.createdAtMillis)+(mv.note?" · "+mv.note:""))+"</small></div><span class='"+(delta<0?"neg":"pos")+"'>"+esc((delta>0?"+":"")+fmt(delta,l).replace(/^-/,"-"))+"<small>"+esc(where)+"</small></span>";
  return row;
 }
 function historySheet(medId){
  const m=medById(medId);const node=el("div","stk-sheet");
  const list=allMoves().filter(x=>x.medicineId===medId).slice(0,40);
  node.append(el("p","muted small-text","Last 3 days"));
  if(!list.length)node.append(el("p","stk-empty","No stock movement in the last 3 days."));
  else{const box=el("div","stk-moves");list.forEach(x=>box.append(moveLine(x,false)));node.append(box);}
  const back=el("button","secondary stk-wide","Back");back.type="button";back.onclick=()=>sheet(medId);node.append(back);
  openAppModal(node,m?.name||"History","Stock history");
 }
 function todaySheet(){
  const start=new Date();start.setHours(0,0,0,0);
  const list=allMoves().filter(x=>x.createdAtMillis>=start.getTime());
  const node=el("div","stk-sheet");
  const moved=list.filter(x=>x.type==="transfer"),recv=list.filter(x=>x.type==="receive"||x.type==="setup"),count=list.filter(x=>x.type==="count");
  const sales={};list.filter(x=>x.type==="sale"||x.type==="refund").forEach(x=>{sales[x.medicineId]=r3((sales[x.medicineId]||0)+(-(Number(x.dc)||0)));});
  const sect=(title,arr)=>{if(!arr.length)return;node.append(el("h4","stk-sub",esc(title)+" <span>"+arr.length+"</span>"));const box=el("div","stk-moves");arr.forEach(x=>box.append(moveLine(x,true)));node.append(box);};
  sect("Moved to counter",moved);
  sect("Stock received",recv);
  sect("Count corrections",count);
  const ids=Object.keys(sales).filter(k=>sales[k]);
  if(ids.length){node.append(el("h4","stk-sub","Sold today <span>"+ids.length+"</span>"));const box=el("div","stk-moves");ids.forEach(id=>{const c=cfgOf(id),l=c?saleLine(c):{label:"unit",per:1},m=medById(id);const row=el("div","stk-move");row.innerHTML="<div><b>"+esc(m?.name||"Medicine")+"</b><small>from bills</small></div><span class='neg'>-"+esc(fmt(sales[id],l))+"</span>";box.append(row);});node.append(box);}
  if(!list.length)node.append(el("p","stk-empty","Nothing recorded today yet."));
  openAppModal(node,"Today","Stock activity since midnight");
 }
 function reorderSheet(){
  const rows=meds().map(m=>({m,c:cfgOf(m.id),s:statusOf(m.id)})).filter(r=>r.c&&(r.s.key==="out"||r.s.key==="low"));
  const node=el("div","stk-sheet");
  if(!rows.length)node.append(el("p","stk-empty","Nothing is low right now."));
  else{
   const lines=[];const box=el("div","stk-moves");
   rows.forEach(r=>{const l=saleLine(r.c),b=balance(r.m.id,l.id),total=b.c+b.g;lines.push(r.m.name+" — "+(total<=0?"OUT":fmt(total,l)+" left"));const row=el("div","stk-move");row.innerHTML="<div><b>"+esc(r.m.name)+"</b><small>Counter "+esc(fmt(b.c,l))+" · Godown "+esc(fmt(b.g,l))+"</small></div><span class='stk-badge "+r.s.key+"'>"+esc(r.s.text)+"</span>";box.append(row);});
   node.append(box);
   const copy=el("button","primary stk-wide","Copy list");copy.type="button";copy.onclick=async()=>{try{await navigator.clipboard.writeText("Order list\n"+lines.join("\n"));notify("List copied","success",2200);}catch(e){notify("Could not copy","warning");}};node.append(copy);
  }
  openAppModal(node,"To order","Medicines that are low or finished");
 }
 function openingSheet(){
  if(!needEdit())return;
  const todo=meds().filter(m=>!cfgOf(m.id));
  if(!todo.length){notify("All medicines are already set up.","info");return;}
  const node=el("form","stk-form");node.noValidate=true;
  node.append(el("p","muted small-text","Type how many packs are on the counter and in the godown. Leave a row empty to skip it. Pack names and sizes are guessed — you can fix them later in Setup."));
  const rows=todo.map(m=>{
   const g=guess(m),row=el("div","stk-open-row");
   const name=el("div","stk-open-name","<b>"+esc(m.name)+"</b><small></small>");
   const per=document.createElement("input");per.type="number";per.min="1";per.step="any";per.inputMode="decimal";per.value=String(g.per);per.setAttribute("aria-label","Items per pack for "+m.name);per.title="Items per pack";
   const sm=name.querySelector("small");
   if(g.per<=1){sm.textContent="Counted in "+g.unit.toLowerCase()+"s";per.hidden=true;sm.append(per);}
   else{sm.append(document.createTextNode("1 "+g.unit.toLowerCase()+" = "));sm.append(per);sm.append(document.createTextNode(" "+String(m.unit||"").toLowerCase()));}
   const c=document.createElement("input"),gd=document.createElement("input");
   for(const [i,lab,n] of [[c,"Counter","openC"],[gd,"Godown","openG"]]){i.type="number";i.min="0";i.step="any";i.inputMode="decimal";i.placeholder=lab;i.name=n;i.setAttribute("aria-label",lab+" packs for "+m.name);}
   row.append(name,c,gd);node.append(row);return {m,g,per,c,gd};
  });
  const act=el("div","stk-buttons");const cancel=el("button","secondary","Cancel");cancel.type="button";cancel.onclick=()=>closeAppModal();const save=el("button","primary","Save opening stock");save.type="submit";act.append(cancel,save);node.append(act);
  node.onsubmit=async e=>{
   e.preventDefault();save.disabled=true;let n=0;
   try{for(const r of rows){const cv=Number(r.c.value)||0,gv=Number(r.gd.value)||0;if(!cv&&!gv)continue;const per=Math.max(1,Number(r.per.value)||1);
     await saveConfig(r.m.id,{lines:[{id:"main",label:r.g.unit,per}],saleLine:"main",unit:r.g.unit,low:0});
     await addMove({type:"setup",medicineId:r.m.id,lineId:"main",dc:r3(cv*per),dg:r3(gv*per),name:r.m.name});n++;}
    closeAppModal();render();flushSoon();notify(n?n+" medicines set up.":"Nothing entered.","success",3600);
   }catch(err){console.error(err);notify("Could not save: "+(err?.message||"error"),"error");save.disabled=false;}
  };
  openAppModal(node,"Opening stock","Starting quantities for your medicines");
 }

 function bind(){
  const s=$("stockSearch");if(s)s.oninput=()=>{term=s.value;render();};
  document.querySelectorAll("#stockFilters .stk-chip").forEach(b=>b.onclick=()=>{filter=b.dataset.f;render();});
  $("stockOpeningBtn")?.addEventListener("click",openingSheet);
  $("stockTodayBtn")?.addEventListener("click",todaySheet);
  $("stockOrderBtn")?.addEventListener("click",reorderSheet);
 }
 bind();
 return {start,stop,render,refresh,syncMove,syncConfig,billEffect,refundEffect,applyBillChange,cfgOf};
}
