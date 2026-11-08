import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, signOut, updateProfile } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getStorage, ref, uploadString, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { openDB } from "https://cdn.jsdelivr.net/npm/idb@8/+esm";

const firebaseConfig={apiKey:"AIzaSyDu3T1shPJoooMNwhpPijfJsPaNc2JWWhM",authDomain:"friends-hospital-pharmacy.firebaseapp.com",projectId:"friends-hospital-pharmacy",storageBucket:"friends-hospital-pharmacy.firebasestorage.app",messagingSenderId:"277311494482",appId:"1:277311494482:web:84f77fd637d765c08f028b",measurementId:"G-RWBC6T7X1T"};
const app=initializeApp(firebaseConfig),auth=initializeAuth(app,{persistence:[indexedDBLocalPersistence,browserLocalPersistence,browserSessionPersistence]}),db=getFirestore(app),storage=getStorage(app);
let localDB=null;async function openUserDB(uid){if(localDB)localDB.close();localDB=await openDB("friends-pharmacy-"+uid,1,{upgrade(d){if(!d.objectStoreNames.contains("medicines"))d.createObjectStore("medicines",{keyPath:"id"});if(!d.objectStoreNames.contains("pending"))d.createObjectStore("pending",{keyPath:"id"});}});}
let medicines=[],bill=[],unsubscribe=null,historyUnsubscribe=null,currentUser=null,roundingApplied=0,roundingBase=null,savedBills=[];
const $=id=>document.getElementById(id),money=n=>"Rs. "+Number(n||0).toFixed(2);
const show=(id,yes)=>$(id).classList.toggle("hidden",!yes);
function status(){ $("connection").textContent=navigator.onLine?"● Online / Firebase sync":"● Offline / Local mode"; }
window.addEventListener("online",status);window.addEventListener("offline",status);status();
async function cacheAll(){const tx=localDB.transaction("medicines","readwrite");await tx.store.clear();for(const m of medicines)await tx.store.put(m);await tx.done;}
async function queueChange(id,type,data=null){await localDB.put("pending",{id,type,data,queuedAt:Date.now()});}
async function flushQueue(){if(!currentUser||!navigator.onLine)return;const jobs=await localDB.getAll("pending");for(const job of jobs){try{const target=doc(db,"users",currentUser.uid,"medicines",job.id);if(job.type==="delete")await deleteDoc(target);else await setDoc(target,job.data);await localDB.delete("pending",job.id);}catch(err){console.warn("Sync will retry:",err);break;}}}
async function syncOnline(){if(!currentUser||!navigator.onLine)return;await flushQueue();if(!unsubscribe)startCloudSync(currentUser);}
window.addEventListener("online",()=>{status();syncOnline();});
async function loadLocal(){medicines=await localDB.getAll("medicines");renderMedicines();}
const UNIT_OPTIONS=["Tablet","Strip","Capsule","Injection","Bottle","Packet","Box","Piece","Pack"];
function normalizeMedicine(m){if(!m.unit||!Number.isFinite(Number(m.price))){const unit=Number(m.stripPrice)>0&&!Number(m.tabletPrice)?"Strip":"Tablet";m={...m,unit:m.unit||unit,price:Number(m.price??(unit==="Strip"?m.stripPrice:m.tabletPrice))||0};}return {...m,tags:Array.isArray(m.tags)?m.tags:[],roundingAllowed:m.roundingAllowed===true};}
function medicineMatches(m,q){const term=q.trim().toLowerCase();return !term||[m.name,...(m.tags||[])].some(v=>String(v).toLowerCase().includes(term));}
function openAddMedicine(prefill=""){
 $("medicineForm").reset();$("medicineId").value="";$("medicineName").value=prefill;
 $("medicineForm").querySelector('button[type="submit"]').textContent="Save medicine";
 show("medicineForm",true);$("medicineName").focus();
}
function emptyAction(message,label,prefill=""){
 const box=document.createElement("div");box.className="empty-state";
 const title=document.createElement("b");title.textContent=message;
 const action=document.createElement("button");action.type="button";action.className="primary";action.textContent=label;
 action.onclick=()=>openAddMedicine(prefill);box.append(title,action);return box;
}
function renderMedicines(filter=""){
 const list=$("medicineList");list.innerHTML="";medicines=medicines.map(normalizeMedicine);
 const filtered=medicines.filter(m=>medicineMatches(m,filter));
 filtered.forEach(m=>{
  const el=document.createElement("article");el.className="medicine-card";
  el.innerHTML=(m.image?'<img alt="">':'<div class="medicine-placeholder">✚</div>')+'<div class="medicine-info"><b></b><small></small></div><div class="card-actions"><button class="tiny edit">Edit</button><button class="tiny danger del">×</button></div>';
  if(m.image)el.querySelector("img").src=m.image;
  el.querySelector(".edit").type="button";el.querySelector(".del").type="button";
  el.querySelector(".medicine-info b").textContent=m.name;
  el.querySelector(".medicine-info small").textContent=m.unit+" · "+money(m.price);
  el.querySelector(".edit").onclick=()=>editMedicine(m);el.querySelector(".del").onclick=()=>removeMedicine(m.id);
  list.append(el);
 });
 if(!filtered.length)list.append(emptyAction(filter?"Medicine not found":"No medicines added yet",filter?"＋ Add new medicine":"＋ Add medicine",filter.trim()));
}
function renderBillSearch(q=""){
 const list=$("billMedicineList");list.innerHTML="";
 const matches=medicines.filter(m=>medicineMatches(m,q));
 matches.forEach(m=>{
  const row=document.createElement("div");row.className="bill-option";
  const info=document.createElement("div");info.innerHTML="<b></b><small></small>";
  info.querySelector("b").textContent=m.name;
  info.querySelector("small").textContent=(m.unit||"Tablet")+" · "+money(m.price??m.tabletPrice);
  const btn=document.createElement("button");btn.type="button";btn.className="tiny add-bill";btn.textContent="＋ Add";
  btn.onclick=()=>{const existing=bill.find(x=>x.id===m.id);if(existing)existing.qty+=1;else bill.push({id:m.id,name:m.name,unit:m.unit||"Tablet",qty:1,price:Number(m.price??m.tabletPrice)||0,roundingAllowed:m.roundingAllowed===true,adjustment:0});renderBill();};
  row.append(info,btn);list.append(row);
 });
 if(!matches.length){
  const box=document.createElement("div");box.className="empty-state";
  const title=document.createElement("b");title.textContent=medicines.length?(q.trim()?"Medicine not found":"No medicines available"):"Add your medicines before creating a bill.";
  const action=document.createElement("button");action.type="button";action.className="primary";action.textContent="＋ Add medicine";
  action.onclick=()=>{document.querySelector('.nav[data-page="medicines"]').click();openAddMedicine(q.trim());};
  box.append(title,action);list.append(box);
 }
}
function roundingSuggestion(total){
 if(total<=0)return 0;
 if(total>4000){
  const halfThousand=Math.ceil((total-0.000001)/500)*500;
  const halfExtra=Number((halfThousand-total).toFixed(2));
  if(halfExtra>0.009&&halfExtra<=150&&Math.round(halfExtra*100)%1000===0)return halfExtra;
 }
 const normalTarget=Math.ceil((total-0.000001)/100)*100;
 const normalExtra=Number((normalTarget-total).toFixed(2));
 return normalExtra>0.009&&normalExtra<=50&&Math.round(normalExtra*100)%1000===0?normalExtra:0;
}
function applyMedicineRounding(extra){
 let remaining=Math.round(extra*100),adjusted=bill.map(x=>({...x,adjustment:0}));
 const eligible=adjusted.filter(x=>x.roundingAllowed);
 if(!eligible.length||remaining<=0||remaining%1000!==0)return null;
 let index=0;
 while(remaining>=1000){
  const item=eligible[index%eligible.length];
  const step=remaining>=2000?2000:1000;
  item.adjustment=(item.adjustment||0)+step/100;
  remaining-=step;
  index++;
 }
 return remaining===0?adjusted:null;
}
function renderBill(){
 const root=$("billItems");root.innerHTML="";
 if(!bill.length)root.innerHTML='<p class="muted">No items added yet.</p>';
 bill.forEach((it,i)=>{
  const row=document.createElement("div");row.className="bill-row";
  const name=document.createElement("span");name.className="bill-item-name";name.textContent=it.name+" ("+it.unit+")";
  const controls=document.createElement("div");controls.className="qty-controls";
  const unitLabel=document.createElement("small");unitLabel.className="qty-unit-label";unitLabel.textContent=it.unit||"Piece";
  const minus=document.createElement("button");minus.type="button";minus.className="qty-btn";minus.textContent="−";minus.setAttribute("aria-label","Decrease quantity");minus.onclick=()=>{it.qty=Math.max(1,it.qty-1);renderBill();};
  const qty=document.createElement("input");qty.type="number";qty.min="1";qty.step="1";qty.value=it.qty;qty.setAttribute("aria-label","Quantity");qty.onchange=()=>{it.qty=Math.max(1,Math.floor(Number(qty.value)||1));renderBill();};
  const plus=document.createElement("button");plus.type="button";plus.className="qty-btn";plus.textContent="+";plus.setAttribute("aria-label","Increase quantity");plus.onclick=()=>{it.qty+=1;renderBill();};
  controls.append(minus,qty,plus,unitLabel);
  const lineTotal=it.price*it.qty+(it.adjustment||0),price=document.createElement("b");price.className="bill-line-total";price.textContent=money(lineTotal);
  const del=document.createElement("button");del.type="button";del.className="remove-item";del.textContent="×";del.title="Remove item";del.setAttribute("aria-label","Remove "+it.name);del.onclick=()=>{bill.splice(i,1);renderBill();};
  row.append(name,controls,price,del);root.append(row);
 });
 const sub=bill.reduce((sum,item)=>sum+item.qty*item.price,0);
 const applied=bill.reduce((sum,item)=>sum+(item.adjustment||0),0);
 const discount=Math.min(sub,Math.max(0,Number($("discount").value)||0));
 const base=Math.max(0,sub-discount);
 if(roundingBase!==base){roundingBase=base;roundingApplied=0;bill.forEach(item=>item.adjustment=0);}
 const currentAdjustment=bill.reduce((sum,item)=>sum+(item.adjustment||0),0);
 const suggestion=currentAdjustment>0||!bill.some(item=>item.roundingAllowed)?0:roundingSuggestion(base);
 $("subtotal").textContent=money(sub);
 $("roundingAmount").textContent=suggestion>0?"+ "+money(suggestion):"";
 $("roundingApply").classList.toggle("hidden",!(suggestion>0));
 $("roundingApply").textContent="Apply";
 $("roundingAppliedLabel").textContent=currentAdjustment>0?"Medicine prices adjusted: + "+money(currentAdjustment):"";
 $("finalTotal").textContent=money(base+currentAdjustment);
 $("roundingApply").onclick=()=>{
  const adjusted=applyMedicineRounding(suggestion);
  if(!adjusted){$("billMessage").textContent="Rounding is not possible: add eligible medicines or use a target reachable in Rs. 10 increments.";return;}
  bill=adjusted;roundingApplied=suggestion;$("billMessage").textContent="Eligible medicine prices adjusted for this bill only.";renderBill();
 };
}

async function saveMedicine(e){
 e.preventDefault();
 const id=$("medicineId").value||crypto.randomUUID(),old=medicines.find(m=>m.id===id);
 let image=old?.image||"";
 const file=$("medicineImage").files[0];
 if(file){
  if(file.size>8*1024*1024){alert("Image must be 8 MB or smaller.");return;}
  image=await new Promise((resolve,reject)=>{
   const reader=new FileReader();
   reader.onload=()=>{const img=new Image();img.onload=()=>{const canvas=document.createElement("canvas"),scale=Math.min(1,900/Math.max(img.width,img.height));canvas.width=Math.round(img.width*scale);canvas.height=Math.round(img.height*scale);canvas.getContext("2d").drawImage(img,0,0,canvas.width,canvas.height);resolve(canvas.toDataURL("image/jpeg",0.65));};img.onerror=reject;img.src=reader.result;};
   reader.onerror=reject;reader.readAsDataURL(file);
  });
 }
 const tags=[...new Set($("medicineTags").value.split(",").map(x=>x.trim()).filter(Boolean))];
 const m={id,name:$("medicineName").value.trim(),tags,roundingAllowed:$("roundingAllowed").checked,unit:$("medicineUnit").value,price:Math.max(0,Number($("medicinePrice").value)||0),image,updatedAt:Date.now()};
 if(!m.name)return;
 medicines=medicines.filter(x=>x.id!==id).concat(m);
 await localDB.put("medicines",m);await queueChange(id,"set",m);
 renderMedicines($("medicineSearch").value);
 $("medicineForm").reset();$("medicineId").value="";
 $("medicineForm").querySelector('button[type="submit"]').textContent="Save medicine";
 show("medicineForm",false);if(navigator.onLine)syncOnline();
}
function editMedicine(m){
 m=normalizeMedicine(m);$("medicineId").value=m.id;$("medicineName").value=m.name;
 $("medicineUnit").value=m.unit;$("medicinePrice").value=m.price;
 $("medicineTags").value=(m.tags||[]).join(", ");$("roundingAllowed").checked=m.roundingAllowed===true;
 $("medicineForm").querySelector('button[type="submit"]').textContent="Update medicine";
 show("medicineForm",true);window.scrollTo({top:0,behavior:"smooth"});
}
async function removeMedicine(id){
 if(!confirm("Delete this medicine?"))return;
 medicines=medicines.filter(m=>m.id!==id);await localDB.delete("medicines",id);
 await queueChange(id,"delete");renderMedicines($("medicineSearch").value);
 if(navigator.onLine)syncOnline();
}
function startCloudSync(user){
 if(unsubscribe)unsubscribe();
 unsubscribe=onSnapshot(collection(db,"users",user.uid,"medicines"),async snap=>{
  const pending=await localDB.getAll("pending"),pendingIds=new Set(pending.map(x=>x.id));
  const cloud=snap.docs.map(d=>normalizeMedicine(d.data())).filter(m=>!pendingIds.has(m.id));
  const local=await localDB.getAll("medicines"),merged=new Map(cloud.map(m=>[m.id,m]));
  for(const m of local)if(pendingIds.has(m.id))merged.set(m.id,m);
  medicines=[...merged.values()];await cacheAll();renderMedicines($("medicineSearch").value);await flushQueue();
 },err=>console.warn("Firestore sync",err));
}
document.querySelectorAll(".password-toggle").forEach(button=>{button.onclick=()=>{const input=$(button.dataset.passwordTarget);if(!input)return;const reveal=input.type==="password";input.type=reveal?"text":"password";button.setAttribute("aria-label",reveal?"Hide password":"Show password");button.title=reveal?"Hide password":"Show password";button.classList.toggle("is-visible",reveal);};});
function setAuthLoading(buttonId,loading,label){const button=$(buttonId);if(!button)return;button.disabled=loading;button.classList.toggle("is-loading",loading);button.querySelector(".button-label").textContent=loading?label:button.dataset.defaultLabel;button.querySelector(".button-spinner").classList.toggle("hidden",!loading);}
$("loginSubmit").dataset.defaultLabel="Sign in";$("registerSubmit").dataset.defaultLabel="Create account";
$("loginForm").onsubmit=async e=>{e.preventDefault();setAuthLoading("loginSubmit",true,"Signing in…");$("loginMessage").textContent="";try{await signInWithEmailAndPassword(auth,$("email").value.trim(),$("password").value);}catch(err){$("loginMessage").textContent=authError(err);}finally{setAuthLoading("loginSubmit",false);}};
function authError(err){const messages={"auth/invalid-email":"Please enter a valid email address.","auth/user-not-found":"No account found with this email. Please register first.","auth/wrong-password":"Incorrect password. Try again.","auth/invalid-credential":"Email or password is incorrect.","auth/email-already-in-use":"This email is already registered. Please sign in.","auth/weak-password":"Password must be at least 6 characters.","auth/too-many-requests":"Too many attempts. Please try again later.","auth/network-request-failed":"Network error. Check your internet connection."};return messages[err.code]||err.message;}
$("showRegister").onclick=()=>{show("loginForm",false);show("registerForm",true);$("authHeading").textContent="Create account";$("authSubtitle").textContent="Register your pharmacy account";$("loginMessage").textContent="";$("registerMessage").textContent="";};
$("showLogin").onclick=()=>{show("registerForm",false);show("loginForm",true);$("authHeading").textContent="Friends Hospital Pharmacy";$("authSubtitle").textContent="Sign in to continue";$("loginMessage").textContent="";$("registerMessage").textContent="";};
$("registerForm").onsubmit=async e=>{e.preventDefault();const name=$("registerName").value.trim(),email=$("registerEmail").value.trim(),password=$("registerPassword").value,confirm=$("confirmPassword").value;if(password.length<6){$("registerMessage").textContent="Password must be at least 6 characters.";return;}if(password!==confirm){$("registerMessage").textContent="Passwords do not match.";return;}$("registerMessage").textContent="";setAuthLoading("registerSubmit",true,"Creating account…");try{const credential=await createUserWithEmailAndPassword(auth,email,password);if(name)await updateProfile(credential.user,{displayName:name});$("registerMessage").textContent="Account created successfully.";}catch(err){$("registerMessage").textContent=authError(err);}finally{setAuthLoading("registerSubmit",false);}};
$("forgotPassword").onclick=async()=>{const email=$("email").value.trim();if(!email){$("loginMessage").textContent="Enter your email address first, then select Forgot password.";return;}try{await sendPasswordResetEmail(auth,email);$("loginMessage").textContent="Password reset email sent. Check your inbox.";}catch(err){$("loginMessage").textContent=authError(err);}};
onAuthStateChanged(auth,async user=>{currentUser=user;if(user){await openUserDB(user.uid);show("loginView",false);show("appView",true);$("userLabel").textContent=user.displayName||user.email;$("settingsEmail").textContent=user.email;try{await loadLocal();}catch(err){console.warn("Local medicine cache unavailable:",err);renderMedicines();}if(unsubscribe)unsubscribe();if(navigator.onLine){startCloudSync(user);flushQueue().catch(err=>console.warn("Pending sync will retry:",err));}status();}else{show("loginView",true);show("appView",false);if(unsubscribe){unsubscribe();unsubscribe=null;}if(historyUnsubscribe){historyUnsubscribe();historyUnsubscribe=null;}if(localDB){localDB.close();localDB=null;}medicines=[];savedBills=[];}});
$("logoutBtn").onclick=()=>signOut(auth);
$("addMedicineBtn").onclick=()=>openAddMedicine();
$("cancelMedicine").onclick=()=>{show("medicineForm",false);$("medicineForm").reset();$("medicineId").value="";$("medicineForm").querySelector('button[type="submit"]').textContent="Save medicine";};$("medicineForm").onsubmit=saveMedicine;
$("medicineSearch").oninput=e=>renderMedicines(e.target.value);$("billSearch").oninput=e=>renderBillSearch(e.target.value);$("discount").oninput=renderBill;
document.querySelectorAll(".nav[data-page]").forEach(b=>b.onclick=()=>{document.querySelectorAll(".nav[data-page]").forEach(x=>x.classList.toggle("active",x===b));["medicines","billing","history","settings"].forEach(p=>show(p+"Page",p===b.dataset.page));$("pageTitle").textContent=b.textContent.trim().replace(/^\S+\s*/,"");if(b.dataset.page==="billing")renderBillSearch();if(b.dataset.page==="history")startBillingHistory();});
async function buildBillSnapshot(){
 const patientName=$("patientName").value.trim();
 if(!patientName){$("billMessage").textContent="Please enter the patient name."; $("patientName").focus();return null;}
 if(!bill.length){$("billMessage").textContent="Add at least one medicine before saving.";return null;}
 const subtotal=bill.reduce((sum,item)=>sum+Number(item.qty)*Number(item.price),0);
 const discount=Math.min(subtotal,Math.max(0,Number($("discount").value)||0));
 const rounding=bill.reduce((sum,item)=>sum+(item.adjustment||0),0);
 const finalTotal=Math.max(0,subtotal-discount)+rounding;
 const adjustedItems=bill.map(item=>{const lineTotal=Number(item.qty)*Number(item.price)+(item.adjustment||0);return {medicineId:item.id,name:item.name,unit:item.unit,quantity:Number(item.qty),unitPrice:lineTotal/Number(item.qty),originalUnitPrice:Number(item.price),lineAdjustment:item.adjustment||0,lineTotal};});
 const now=new Date();
 const receiptNumber="FHP-"+now.toISOString().replace(/[-:T.Z]/g,"").slice(0,14)+"-"+crypto.randomUUID().slice(0,6).toUpperCase();
 return {id:crypto.randomUUID(),receiptNumber,patientName,tokenNumber:$("tokenNumber").value.trim()||"",items:adjustedItems,subtotal,discount,rounding,finalTotal,createdAt:now.toISOString(),createdAtMillis:now.getTime(),ownerUid:currentUser.uid};
}
async function saveCurrentBill({printAfter=false}={}){
 if(!currentUser){$("billMessage").textContent="Please sign in again.";return;}
 $("saveBill").disabled=true;$("printBill").disabled=true;$("billMessage").textContent="Saving bill…";
 try{
  const snapshot=await buildBillSnapshot();if(!snapshot)return;
  await setDoc(doc(db,"users",currentUser.uid,"bills",snapshot.id),{...snapshot,createdAt:serverTimestamp()});
  $("billMessage").textContent="Bill saved successfully. Receipt: "+snapshot.receiptNumber;
   savedBills=[snapshot,...savedBills.filter(x=>x.id!==snapshot.id)];renderBillingHistory();
  bill=[];$("patientName").value="";$("tokenNumber").value="";$("discount").value="0";roundingApplied=0;roundingBase=null;renderBill();
  if(printAfter){showReceipt(snapshot);printReceipt();}
 }catch(err){console.error("Save bill failed:",err);const reason=err?.code==="permission-denied"?"Firebase permission denied. Firestore rules must allow your signed-in account to create/read bills.":err?.code==="unavailable"?"Firebase is unavailable. Check your internet connection and retry.":(err?.message||"Unknown error");$("billMessage").textContent="Bill was not saved: "+reason;}
 finally{$("saveBill").disabled=false;$("printBill").disabled=false;}
}
$("saveBill").onclick=()=>saveCurrentBill();
$("printBill").onclick=()=>saveCurrentBill({printAfter:true});
function startBillingHistory(){
 if(!currentUser)return;
 if(historyUnsubscribe)historyUnsubscribe();
 $("billingHistoryList").innerHTML='<p class="muted">Loading billing history…</p>';
 historyUnsubscribe=onSnapshot(collection(db,"users",currentUser.uid,"bills"),snap=>{
  savedBills=snap.docs.map(d=>d.data()).sort((x,y)=>(y.createdAtMillis||0)-(x.createdAtMillis||0));
  renderBillingHistory();
 },err=>{$("billingHistoryList").innerHTML='<p class="message">Could not load billing history. Check Firestore permissions.</p>';console.warn("Billing history:",err);});
}
function renderBillingHistory(){
 const root=$("billingHistoryList");if(!root)return;
 const q=($("historySearch")?.value||"").trim().toLowerCase();
 const rows=savedBills.filter(x=>(x.receiptNumber||"").toLowerCase().includes(q)||(x.patientName||"").toLowerCase().includes(q));
 root.innerHTML="";
 if(!rows.length){root.innerHTML='<p class="muted">No saved bills found.</p>';return;}
 rows.forEach(item=>{
  const row=document.createElement("button");row.type="button";row.className="history-row";
  const info=document.createElement("span");info.innerHTML="<b></b><small></small>";
  info.querySelector("b").textContent=item.patientName||"Patient";
  info.querySelector("small").textContent=(item.receiptNumber||"Receipt")+" · "+new Date(item.createdAtMillis||Date.now()).toLocaleString();
  const total=document.createElement("strong");total.textContent=money(item.finalTotal);
  row.append(info,total);row.onclick=()=>showReceipt(item);root.append(row);
 });
}
function printReceipt(){
 const root=$("receiptDetail");if(!root)return;
 root.classList.add("printing-receipt");
 const history=$("historyPage");history.classList.remove("hidden");
 window.print();
 root.classList.remove("printing-receipt");
 if(!document.querySelector(".nav[data-page='history'].active"))history.classList.add("hidden");
}
function showReceipt(item){
 const root=$("receiptDetail");if(!root)return;
 root.classList.remove("hidden");root.innerHTML="";
 const brand=document.createElement("div");brand.className="receipt-brand";
 const brandName=document.createElement("b");brandName.textContent="FRIENDS HOSPITAL PHARMACY";
 const brandSub=document.createElement("small");brandSub.textContent="MEDICINE BILL";
 brand.append(brandName,brandSub);root.append(brand);
 const title=document.createElement("h3");title.textContent=item.receiptNumber;root.append(title);
 const meta=document.createElement("div");meta.className="receipt-meta";
 const patient=document.createElement("span");patient.textContent="Patient: "+(item.patientName||"—");
 const details=document.createElement("span");details.textContent=(item.tokenNumber?"Token: "+item.tokenNumber+" · ":"")+new Date(item.createdAtMillis||Date.now()).toLocaleString();
 meta.append(patient,details);root.append(meta);
 const table=document.createElement("div");table.className="receipt-lines";
 const head=document.createElement("div");head.className="receipt-line receipt-head";
 ["Medicine","Qty","Amount"].forEach(label=>{const cell=document.createElement("span");cell.textContent=label;head.append(cell);});
 table.append(head);
 (item.items||[]).forEach(line=>{
  const row=document.createElement("div");row.className="receipt-line";
  const name=document.createElement("span");name.className="receipt-medicine";name.textContent=line.name;
  const qty=document.createElement("span");qty.className="receipt-qty";qty.textContent=String(line.quantity)+" "+line.unit;
  const amount=document.createElement("b");amount.className="receipt-amount";amount.textContent=Number(line.lineTotal||0).toFixed(2);
  row.append(name,qty,amount);table.append(row);
 });root.append(table);
 const summary=document.createElement("div");summary.className="receipt-summary";
 const addTotal=(label,value,kind="")=>{const row=document.createElement("div");row.className="receipt-summary-row"+(kind?" "+kind:"");const l=document.createElement("span");l.textContent=label;const v=document.createElement("b");v.textContent=Number(value||0).toFixed(2);row.append(l,v);summary.append(row);};
 if(Number(item.discount)>0){addTotal("Subtotal",item.subtotal);addTotal("Discount",item.discount,"discount");addTotal("TOTAL",item.finalTotal,"final");}
 else addTotal("TOTAL",item.finalTotal,"final");
 root.append(summary);
 const footer=document.createElement("p");footer.className="receipt-thanks";footer.textContent="Thank you. Get well soon!";root.append(footer);
 const print=document.createElement("button");print.type="button";print.className="secondary print-hide";print.textContent="Print receipt";print.onclick=printReceipt;root.append(print);
 root.scrollIntoView({behavior:"smooth",block:"start"});
}
$("historySearch").oninput=renderBillingHistory;
$("saveName").onclick=async()=>{if(!currentUser)return;await updateProfile(currentUser,{displayName:$("displayName").value.trim()});$("userLabel").textContent=$("displayName").value.trim()||currentUser.email;};
$("exportData").onclick=()=>{const blob=new Blob([JSON.stringify({version:1,exportedAt:new Date().toISOString(),medicines},null,2)],{type:"application/json"}),a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="friends-pharmacy-backup.json";a.click();URL.revokeObjectURL(a.href);};

let installPrompt=null;function updateInstallButton(){const installed=window.matchMedia("(display-mode: standalone)").matches||window.navigator.standalone===true;show("installAppWrap",!!installPrompt&&!installed);}window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();installPrompt=e;updateInstallButton();});window.addEventListener("appinstalled",()=>{installPrompt=null;updateInstallButton();});$("installAppBtn").onclick=async()=>{if(!installPrompt)return;installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;updateInstallButton();};window.matchMedia("(display-mode: standalone)").addEventListener?.("change",updateInstallButton);if("serviceWorker" in navigator)window.addEventListener("load",()=>navigator.serviceWorker.register("./service-worker.js",{updateViaCache:"none"}).catch(err=>console.warn("Service worker:",err)));updateInstallButton();
$("importData").onchange=async e=>{const f=e.target.files[0];if(!f)return;try{const data=JSON.parse(await f.text());if(!Array.isArray(data.medicines))throw Error("Invalid backup");for(const m of data.medicines){if(!m.id||!m.name)continue;await localDB.put(m);await queueChange(m.id,"set",m);}if(navigator.onLine)await flushQueue();medicines=await localDB.getAll("medicines");renderMedicines();alert("Backup imported.");}catch(err){alert("Import failed: "+err.message);}e.target.value="";};
