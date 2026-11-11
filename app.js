import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, signOut, updateProfile, EmailAuthProvider, reauthenticateWithCredential } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, collection, doc, setDoc, getDoc, deleteDoc, onSnapshot, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getStorage, ref, uploadString, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { openDB } from "https://cdn.jsdelivr.net/npm/idb@8/+esm";

const firebaseConfig={apiKey:"AIzaSyDu3T1shPJoooMNwhpPijfJsPaNc2JWWhM",authDomain:"friends-hospital-pharmacy.firebaseapp.com",projectId:"friends-hospital-pharmacy",storageBucket:"friends-hospital-pharmacy.firebasestorage.app",messagingSenderId:"277311494482",appId:"1:277311494482:web:84f77fd637d765c08f028b",measurementId:"G-RWBC6T7X1T"};
const app=initializeApp(firebaseConfig),auth=initializeAuth(app,{persistence:[indexedDBLocalPersistence,browserLocalPersistence,browserSessionPersistence]}),db=getFirestore(app),storage=getStorage(app);
const SUPPORT_WHATSAPP="923486314013";
let localDB=null;async function openUserDB(uid){if(localDB)localDB.close();localDB=await openDB("friends-pharmacy-"+uid,3,{upgrade(d){if(!d.objectStoreNames.contains("medicines"))d.createObjectStore("medicines",{keyPath:"id"});if(!d.objectStoreNames.contains("pending"))d.createObjectStore("pending",{keyPath:"id"});if(!d.objectStoreNames.contains("meta"))d.createObjectStore("meta");if(!d.objectStoreNames.contains("bills"))d.createObjectStore("bills",{keyPath:"id"});}});}
let medicines=[],bill=[],unsubscribe=null,historyUnsubscribe=null,currentUser=null,roundingApplied=0,roundingBase=null,savedBills=[],editingBillId=null,editingBillCreatedAt=0,syncPromise=null,syncNotice="",medicineModeEnabled=true,medicineImageDraft="",medicineImageRotation=0,medicineImageCrop=false;
const $=id=>document.getElementById(id),money=n=>"Rs. "+Number(n||0).toFixed(2);
const show=(id,yes)=>$(id).classList.toggle("hidden",!yes);
let modalNode=null,modalPlaceholder=null,modalKind="",billSearchActiveIndex=-1;
function openAppModal(node,title,subtitle="",kind="content"){
 if(!node)return;
 if(modalNode)closeAppModal();
 modalNode=node;modalKind=kind;modalPlaceholder=document.createComment("modal-origin");
 if(node.parentNode)node.parentNode.insertBefore(modalPlaceholder,node);else modalPlaceholder=null;
 $("appModalTitle").textContent=title;$("appModalSubtitle").textContent=subtitle;
 $("appModalBody").replaceChildren(node);$("appModal").classList.remove("hidden");
 document.body.classList.add("modal-open");
}
function closeAppModal(){
 if(modalNode&&modalPlaceholder?.parentNode){modalPlaceholder.parentNode.insertBefore(modalNode,modalPlaceholder);modalPlaceholder.remove();}
 if(modalNode&&modalKind==="view")modalNode.classList.add("hidden");
 $("appModal").classList.add("hidden");$("appModalBody").replaceChildren();
 document.body.classList.remove("modal-open");modalNode=null;modalPlaceholder=null;modalKind="";
}
function confirmAction(title,message,confirmLabel="Delete"){
 return new Promise(resolve=>{
  const box=document.createElement("div");box.className="confirm-dialog-content";
  const copy=document.createElement("p");copy.textContent=message;
  const actions=document.createElement("div");actions.className="modal-actions";
  const cancel=document.createElement("button");cancel.type="button";cancel.className="secondary";cancel.textContent="Cancel";
  const yes=document.createElement("button");yes.type="button";yes.className="danger-button";yes.textContent=confirmLabel;
  actions.append(cancel,yes);box.append(copy,actions);
  const finish=value=>{closeAppModal();resolve(value);};
  cancel.onclick=()=>finish(false);yes.onclick=()=>finish(true);
  openAppModal(box,title,"Please confirm this action.","confirm");
 });
}
$("appModalClose").onclick=()=>{if(modalKind==="edit")cancelBillEdit();else if(modalKind==="medicine")closeMedicineModal();else closeAppModal();};
$("appModal").addEventListener("click",e=>{if(e.target===$("appModal")){if(modalKind==="edit")cancelBillEdit();else if(modalKind==="medicine")closeMedicineModal();else closeAppModal();}});
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!$("appModal").classList.contains("hidden")){if(modalKind==="edit")cancelBillEdit();else if(modalKind==="medicine")closeMedicineModal();else closeAppModal();}});
function status(){ $("connection").textContent=navigator.onLine?"● Online / Firebase sync":"● Offline / Local mode"; }
window.addEventListener("online",status);window.addEventListener("offline",status);status();
async function cacheAll(){const tx=localDB.transaction("medicines","readwrite");await tx.store.clear();for(const m of medicines)await tx.store.put(m);await tx.done;}
async function queueChange(id,type,data=null,collectionName="medicines"){const key=collectionName+":"+id;await localDB.put("pending",{id:key,targetId:id,collectionName,type,data,queuedAt:Date.now()});}
async function flushQueue(){if(syncPromise)return syncPromise;if(!currentUser||!navigator.onLine||!localDB)return;const ownerUid=currentUser.uid,dbRef=localDB;syncPromise=(async()=>{const jobs=(await dbRef.getAll("pending")).sort((a,b)=>a.queuedAt-b.queuedAt);for(const job of jobs){if(!navigator.onLine||!currentUser||currentUser.uid!==ownerUid||localDB!==dbRef)break;const group=job.collectionName||"medicines",targetId=job.targetId||job.id;try{const target=doc(db,"users",ownerUid,group,targetId);if(group==="bills"){const existing=await getDoc(target);if(job.type==="delete"){if(existing.exists())await deleteDoc(target);}else if(existing.exists()){await setDoc(target,{...job.data,createdAt:existing.data().createdAt||serverTimestamp()});}else{await setDoc(target,{...job.data,createdAt:serverTimestamp()});}}else{if(job.type==="delete")await deleteDoc(target);else await setDoc(target,job.data);}if(localDB===dbRef&&currentUser?.uid===ownerUid)await dbRef.delete("pending",job.id);}catch(err){console.warn("Sync will retry:",err);if(err?.code==="permission-denied"){
 if(group==="bills"&&job.type==="delete"){
  try{
   let rejectedBill=job.data;if(!rejectedBill){const cloudBill=await getDoc(doc(db,"users",ownerUid,"bills",targetId));rejectedBill=cloudBill.exists()?cloudBill.data():null;}
   if(rejectedBill){await dbRef.put("bills",rejectedBill);savedBills=[rejectedBill,...savedBills.filter(x=>x.id!==targetId)];}
   await dbRef.delete("pending",job.id);
   syncNotice="Firebase ne bill deletion reject kar di (1-hour limit ya permission). Bill history mein restore kar diya gaya hai.";
   renderBillingHistory();
  }catch(restoreErr){console.warn("Could not restore rejected bill deletion:",restoreErr);}
  continue;
 }
 continue;
}break;}}})().finally(()=>{syncPromise=null;});return syncPromise;}
async function syncOnline(){if(!currentUser||!navigator.onLine)return;await flushQueue();if(!unsubscribe)startCloudSync(currentUser);}
window.addEventListener("online",()=>{status();syncOnline();});
async function nextBillNumber(){
 const localBills=localDB?await localDB.getAll("bills"):[];const maxLocal=localBills.reduce((n,x)=>Math.max(n,Number(String(x.receiptNumber||"").replace(/^B-/,""))||0),0);const current=Math.max(Number(await localDB.get("meta","billCounter"))||0,maxLocal);
 const next=current+1;
 await localDB.put("meta",next,"billCounter");
 return "B-"+String(next).padStart(6,"0");
}
async function loadLocal(){medicines=await localDB.getAll("medicines");renderMedicines();}
const UNIT_OPTIONS=["Tablet","Strip","Capsule","Injection","Bottle","Packet","Box","Piece","Pack"];
function normalizeMedicine(m){if(!m.unit||!Number.isFinite(Number(m.price))){const unit=Number(m.stripPrice)>0&&!Number(m.tabletPrice)?"Strip":"Tablet";m={...m,unit:m.unit||unit,price:Number(m.price??(unit==="Strip"?m.stripPrice:m.tabletPrice))||0};}return {...m,tags:Array.isArray(m.tags)?m.tags:[],roundingAllowed:m.roundingAllowed===true};}
function medicineMatches(m,q){const term=q.trim().toLowerCase();return !term||[m.name,...(m.tags||[])].some(v=>String(v).toLowerCase().includes(term));}
function resetMedicineImagePreview(){medicineImageDraft="";medicineImageRotation=0;medicineImageCrop=false;const preview=$("medicineImagePreview");if(preview){preview.innerHTML="";preview.classList.add("hidden");}const picker=$("medicineImagePicker");if(picker)picker.classList.remove("has-image");const change=$("changeMedicineImage");if(change)change.textContent="＋ Upload image";}
function showMedicineImagePreview(src){medicineImageDraft=src;const preview=$("medicineImagePreview");if(!preview)return;preview.innerHTML="";const img=document.createElement("img");img.src=src;img.alt="Selected medicine image";const edit=document.createElement("button");edit.type="button";edit.className="image-edit-open";edit.textContent="Edit image";edit.onclick=openMedicineImageEditor;preview.append(img,edit);preview.classList.remove("hidden");$("medicineImagePicker")?.classList.add("has-image");const change=$("changeMedicineImage");if(change)change.textContent="Change image";}
function openMedicineImageEditor(){
 if(!medicineModeEnabled||!medicineImageDraft)return;
 const overlay=document.createElement("div");overlay.className="medicine-editor-overlay";const wrap=document.createElement("div");wrap.className="medicine-editor";
 const preview=document.createElement("div");preview.className="medicine-editor-preview";
 const img=document.createElement("img");img.src=medicineImageDraft;img.alt="Image editor preview";preview.append(img);
 const controls=document.createElement("div");controls.className="medicine-editor-controls";
 const left=document.createElement("button"),right=document.createElement("button"),crop=document.createElement("button");
 [left,right,crop].forEach(b=>{b.type="button";b.className="secondary";});
 left.textContent="↶ Rotate left";right.textContent="↷ Rotate right";crop.textContent="Square crop: OFF";
 left.onclick=()=>{medicineImageRotation=(medicineImageRotation+270)%360;img.style.transform="rotate("+medicineImageRotation+"deg)";};
 right.onclick=()=>{medicineImageRotation=(medicineImageRotation+90)%360;img.style.transform="rotate("+medicineImageRotation+"deg)";};
 crop.onclick=()=>{medicineImageCrop=!medicineImageCrop;crop.textContent=medicineImageCrop?"Square crop: ON":"Square crop: OFF";preview.classList.toggle("square-crop",medicineImageCrop);};
 controls.append(left,right,crop);
 const note=document.createElement("p");note.className="muted small-text";note.textContent="Rotate the image and optionally crop it to a square before saving.";
 const actions=document.createElement("div");actions.className="modal-actions";
 const cancel=document.createElement("button"),apply=document.createElement("button");cancel.type=apply.type="button";cancel.className="secondary";apply.className="primary";cancel.textContent="Cancel";apply.textContent="Apply image";
 cancel.onclick=()=>overlay.remove();
 apply.onclick=()=>{
  const source=new Image();source.onload=()=>{
   const radians=medicineImageRotation*Math.PI/180,sw=source.width,sh=source.height;
   const rw=Math.abs(Math.cos(radians))*sw+Math.abs(Math.sin(radians))*sh,rh=Math.abs(Math.sin(radians))*sw+Math.abs(Math.cos(radians))*sh;
   const rotated=document.createElement("canvas");rotated.width=Math.ceil(rw);rotated.height=Math.ceil(rh);
   const ctx=rotated.getContext("2d");ctx.translate(rotated.width/2,rotated.height/2);ctx.rotate(radians);ctx.drawImage(source,-sw/2,-sh/2);
   let output=rotated;
   if(medicineImageCrop){const side=Math.min(rotated.width,rotated.height),x=Math.floor((rotated.width-side)/2),y=Math.floor((rotated.height-side)/2),cropped=document.createElement("canvas");cropped.width=side;cropped.height=side;cropped.getContext("2d").drawImage(rotated,x,y,side,side,0,0,side,side);output=cropped;}
   const scale=Math.min(1,1200/Math.max(output.width,output.height)),finalCanvas=document.createElement("canvas");finalCanvas.width=Math.max(1,Math.round(output.width*scale));finalCanvas.height=Math.max(1,Math.round(output.height*scale));finalCanvas.getContext("2d").drawImage(output,0,0,finalCanvas.width,finalCanvas.height);
   showMedicineImagePreview(finalCanvas.toDataURL("image/jpeg",.86));$("medicineImage").value="";medicineImageRotation=0;medicineImageCrop=false;overlay.remove();
  };source.onerror=()=>alert("Could not read this image.");source.src=medicineImageDraft;
 };
 actions.append(cancel,apply);wrap.append(preview,controls,note,actions);overlay.append(wrap);document.body.append(overlay);
}
function openAddMedicine(prefill=""){
 if(!medicineModeEnabled||!currentUser||!localDB)return;
 $("medicineForm").reset();$("medicineId").value="";$("medicineName").value=prefill;resetMedicineImagePreview();
 $("medicineForm").querySelector('button[type="submit"]').textContent="Save medicine";
 show("medicineForm",true);openAppModal($("medicineForm"),"Add Medicine","Enter medicine details and optionally upload an image.","medicine");
 $("medicineName").focus();
}
function closeMedicineModal(){
 $("medicineForm").reset();$("medicineId").value="";resetMedicineImagePreview();
 $("medicineForm").querySelector('button[type="submit"]').textContent="Save medicine";
 closeAppModal();show("medicineForm",false);
}
function emptyAction(message,label,prefill=""){
 const box=document.createElement("div");box.className="empty-state";const title=document.createElement("b");title.textContent=message;box.append(title);
 if(medicineModeEnabled){const action=document.createElement("button");action.type="button";action.className="primary";action.textContent=label;action.onclick=()=>openAddMedicine(prefill);box.append(action);}return box;
}
function renderMedicines(filter=""){
 const list=$("medicineList");list.innerHTML="";medicines=medicines.map(normalizeMedicine);$("addMedicineBtn").disabled=!medicineModeEnabled;$("addMedicineBtn").classList.toggle("hidden",!medicineModeEnabled);
 const filtered=medicines.filter(m=>medicineMatches(m,filter));
 filtered.forEach(m=>{
  const el=document.createElement("article");el.className="medicine-card";
  el.innerHTML=(m.image?'<img alt="">':'<div class="medicine-placeholder">✚</div>')+'<div class="medicine-info"><b></b><small></small></div>'+(medicineModeEnabled?'<div class="card-actions"><button class="tiny edit">Edit</button><button class="tiny danger del">×</button></div>':'');
  if(m.image)el.querySelector("img").src=m.image;
  el.querySelector(".medicine-info b").textContent=m.name;
  el.querySelector(".medicine-info small").textContent=m.unit+" · "+money(m.price);
  if(medicineModeEnabled){const edit=el.querySelector(".edit"),del=el.querySelector(".del");edit.type="button";del.type="button";edit.onclick=()=>editMedicine(m);del.onclick=()=>removeMedicine(m.id);}
  list.append(el);
 });
 if(!filtered.length){if(medicineModeEnabled)list.append(emptyAction(filter?"Medicine not found":"No medicines added yet",filter?"＋ Add new medicine":"＋ Add medicine",filter.trim()));else{const empty=document.createElement("div");empty.className="empty-state";const title=document.createElement("b");title.textContent=filter?"Medicine not found":"No medicines available";empty.append(title);list.append(empty);}}
}
function askBillQuantity(m){
 const box=document.createElement("div");box.className="quantity-prompt";
 const label=document.createElement("label");label.textContent="Quantity";
 const input=document.createElement("input");input.type="number";input.min="1";input.step="1";input.value="1";input.inputMode="numeric";input.className="quantity-prompt-input";
 const actions=document.createElement("div");actions.className="modal-actions";
 const cancel=document.createElement("button");cancel.type="button";cancel.className="secondary";cancel.textContent="Cancel";
 const add=document.createElement("button");add.type="button";add.className="primary";add.textContent="Add medicine";
 actions.append(cancel,add);box.append(label,input,actions);
 openAppModal(box,"Add Medicine",m.name+" · "+money(m.price??m.tabletPrice),"quantity");
 const finish=()=>closeAppModal();
 cancel.onclick=finish;
 add.onclick=()=>{
  const qty=Math.floor(Number(input.value));
  if(!Number.isFinite(qty)||qty<1){input.focus();return;}
  const existing=bill.find(x=>x.id===m.id);
  if(existing)existing.qty+=qty;
  else bill.push({id:m.id,name:m.name,unit:m.unit||"Tablet",qty,price:Number(m.price??m.tabletPrice)||0,roundingAllowed:m.roundingAllowed===true,adjustment:0});
  renderBill();$("billSearch").value="";renderBillSearch("");finish();
  setTimeout(()=>{if($("billingPage")&&!$("billingPage").classList.contains("hidden")&&$("appModal").classList.contains("hidden")){$("billSearch").focus();$("billSearch").select();}},80);
 };
 input.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();add.click();}});
 setTimeout(()=>{input.focus();input.select();},0);
}
function renderBillSearch(q=""){
 const list=$("billMedicineList");list.innerHTML="";billSearchActiveIndex=-1;
 const matches=medicines.filter(m=>medicineMatches(m,q));
 matches.forEach(m=>{
  const row=document.createElement("div");row.className="bill-option";row.setAttribute("role","option");row.setAttribute("aria-selected","false");
  const image=m.image?document.createElement("img"):document.createElement("div");
  image.className=m.image?"bill-medicine-image":"bill-medicine-placeholder";
  if(m.image){image.src=m.image;image.alt=m.name;image.loading="lazy";}
  else image.textContent="✚";
  const info=document.createElement("div");info.className="bill-medicine-info";info.innerHTML="<b></b><small></small>";
  info.querySelector("b").textContent=m.name;
  info.querySelector("small").textContent=(m.unit||"Tablet")+" · "+money(m.price??m.tabletPrice);
  const btn=document.createElement("button");btn.type="button";btn.className="tiny add-bill";btn.textContent="＋ Add";
  btn.onclick=()=>askBillQuantity(m);
  row.append(image,info,btn);list.append(row);
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
 if(!Number.isFinite(total)||total<=0)return 0;
 // Final policy: up to 1500 -> 50/100, up to 4000 -> 100,
 // above 4000 -> next 500/1000 if within 150, otherwise next 100.
 const amount=Math.round(total*100)/100;
 const ceilMultiple=(value,step)=>Math.ceil((value-0.0000001)/step)*step;
 let target;
 if(amount<1500)target=ceilMultiple(amount,50);
 else if(amount<=4000)target=ceilMultiple(amount,100);
 else{
  const next500=ceilMultiple(amount,500);
  const difference=next500-amount;
  target=difference>0&&difference<=150?next500:ceilMultiple(amount,100);
 }
 return Math.max(0,Number((target-amount).toFixed(2)));
}
function applyMedicineRounding(extra){
 let remaining=Math.round(extra*100),adjusted=bill.map(x=>({...x,adjustment:0}));
 const eligible=adjusted.filter(x=>x.roundingAllowed);
 if(!eligible.length||remaining<=0)return null;
 const base=Math.floor(remaining/eligible.length),remainder=remaining%eligible.length;
 eligible.forEach((item,index)=>{item.adjustment=Number(((base+(index<remainder?1:0))/100).toFixed(2));});
 return adjusted;
}
function renderBill(){
 const root=$("billItems");root.innerHTML="";
 if(bill.length){root.classList.remove("bill-items-error");if($("patientName").value.trim())$("billMessage").classList.remove("validation-alert");}
 if(!bill.length)root.innerHTML='<p class="muted">No items added yet.</p>';
 bill.forEach((it,i)=>{
  const row=document.createElement("div");row.className="bill-row";
  const serial=document.createElement("span");serial.className="bill-item-serial";serial.textContent=String(i+1)+".";const name=document.createElement("span");name.className="bill-item-name";name.textContent=it.name+" ("+it.unit+")";
  const controls=document.createElement("div");controls.className="qty-controls";
  const unitLabel=document.createElement("small");unitLabel.className="qty-unit-label";unitLabel.textContent=it.unit||"Piece";
  const minus=document.createElement("button");minus.type="button";minus.className="qty-btn";minus.textContent="−";minus.setAttribute("aria-label","Decrease quantity");minus.onclick=()=>{it.qty=Math.max(1,it.qty-1);renderBill();};
  const qty=document.createElement("input");qty.type="number";qty.min="1";qty.step="1";qty.value=it.qty;qty.setAttribute("aria-label","Quantity");qty.onchange=()=>{it.qty=Math.max(1,Math.floor(Number(qty.value)||1));renderBill();};
  const plus=document.createElement("button");plus.type="button";plus.className="qty-btn";plus.textContent="+";plus.setAttribute("aria-label","Increase quantity");plus.onclick=()=>{it.qty+=1;renderBill();};
  controls.append(minus,qty,plus,unitLabel);
  const lineTotal=it.price*it.qty+(it.adjustment||0),price=document.createElement("b");price.className="bill-line-total";price.textContent=money(lineTotal);
  const del=document.createElement("button");del.type="button";del.className="remove-item";del.textContent="×";del.title="Remove item";del.setAttribute("aria-label","Remove "+it.name);del.onclick=()=>{bill.splice(i,1);renderBill();};
  row.append(serial,name,controls,price,del);root.append(row);
 });
 const sub=bill.reduce((sum,item)=>sum+item.qty*item.price,0);
 const applied=bill.reduce((sum,item)=>sum+(item.adjustment||0),0);
 const discount=Math.min(sub,Math.max(0,Number($("discount").value)||0));
 const base=Math.max(0,sub-discount);
 if(roundingBase!==base){roundingBase=base;roundingApplied=0;bill.forEach(item=>item.adjustment=0);}
 const currentAdjustment=bill.reduce((sum,item)=>sum+(item.adjustment||0),0);
 const eligible=bill.some(item=>item.roundingAllowed);
 const suggestion=currentAdjustment>0?0:roundingSuggestion(base);
 $("subtotal").textContent=money(sub);
 $("roundingAmount").textContent=suggestion>0?"+ "+money(suggestion):"";
 $("roundingApply").classList.toggle("hidden",!(suggestion>0));
 $("roundingApply").disabled=!(suggestion>0&&eligible);
 $("roundingApply").textContent="Apply";
 $("roundingAppliedLabel").textContent=currentAdjustment>0?"Medicine prices adjusted: + "+money(currentAdjustment):(suggestion>0&&!eligible?"Rounding available — select at least one medicine marked “Rounding Allowed” to apply.":"");
 $("finalTotal").textContent=money(base+currentAdjustment);
 $("roundingApply").onclick=()=>{
  if(!eligible){$("billMessage").textContent="Select a medicine marked Rounding Allowed first.";return;}
  const adjusted=applyMedicineRounding(suggestion);
  if(!adjusted){$("billMessage").textContent="The adjustment could not be distributed. Check eligible medicines.";return;}
  bill=adjusted;roundingApplied=suggestion;$("billMessage").textContent="Eligible medicine prices adjusted for this bill only.";renderBill();
 };
}

async function saveMedicine(e){
 e.preventDefault();if(!medicineModeEnabled||!currentUser||!localDB)return;
 const id=$("medicineId").value||crypto.randomUUID(),old=medicines.find(m=>m.id===id);
 let image=old?.image||"";
 const file=$("medicineImage").files[0];
 if(file||medicineImageDraft){
  if(file&&file.size>8*1024*1024){alert("Image must be 8 MB or smaller.");return;}
  image=await new Promise((resolve,reject)=>{
   const source=medicineImageDraft||"";const img=new Image();img.onload=()=>{const scale=Math.min(1,1200/Math.max(img.width,img.height)),w=Math.round(img.width*scale),h=Math.round(img.height*scale);const canvas=document.createElement("canvas");canvas.width=w;canvas.height=h;const ctx=canvas.getContext("2d");ctx.drawImage(img,0,0,w,h);resolve(canvas.toDataURL("image/jpeg",0.82));};img.onerror=reject;img.src=source;});
 }
 const tags=[...new Set($("medicineTags").value.split(",").map(x=>x.trim()).filter(Boolean))];
 const m={id,name:$("medicineName").value.trim(),tags,roundingAllowed:$("roundingAllowed").checked,unit:$("medicineUnit").value,price:Math.max(0,Number($("medicinePrice").value)||0),image,updatedAt:Date.now()};
 if(!m.name)return;
 medicines=medicines.filter(x=>x.id!==id).concat(m);
 await localDB.put("medicines",m);await queueChange(id,"set",m);
 renderMedicines($("medicineSearch").value);
 $("medicineForm").reset();$("medicineId").value="";resetMedicineImagePreview();
 $("medicineForm").querySelector('button[type="submit"]').textContent="Save medicine";
 closeAppModal();show("medicineForm",false);if(navigator.onLine)syncOnline();
}
function editMedicine(m){
 if(!medicineModeEnabled)return;
 m=normalizeMedicine(m);resetMedicineImagePreview();if(m.image)showMedicineImagePreview(m.image);$("medicineId").value=m.id;$("medicineName").value=m.name;
 $("medicineUnit").value=m.unit;$("medicinePrice").value=m.price;
 $("medicineTags").value=(m.tags||[]).join(", ");$("roundingAllowed").checked=m.roundingAllowed===true;
 $("medicineForm").querySelector('button[type="submit"]').textContent="Update medicine";
 show("medicineForm",true);openAppModal($("medicineForm"),"Edit Medicine","Update medicine details or replace its uploaded image.","medicine");
}
async function removeMedicine(id){
 if(!medicineModeEnabled)return;
 if(!await confirmAction("Delete medicine","Are you sure you want to delete this medicine?","Delete medicine"))return;
 medicines=medicines.filter(m=>m.id!==id);await localDB.delete("medicines",id);
 await queueChange(id,"delete");renderMedicines($("medicineSearch").value);
 if(navigator.onLine)syncOnline();
}
function startCloudSync(user){
 if(unsubscribe)unsubscribe();
 unsubscribe=onSnapshot(collection(db,"users",user.uid,"medicines"),async snap=>{
  const pending=await localDB.getAll("pending"),pendingIds=new Set(pending.filter(x=>(x.collectionName||"medicines")==="medicines").map(x=>x.targetId||x.id));
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
onAuthStateChanged(auth,async user=>{currentUser=user;if(user){await openUserDB(user.uid);const savedEditPassword=await localDB.get("meta","medicineEditPassword");medicineModeEnabled=!!savedEditPassword&&(await localDB.get("meta","medicineModeEnabled"))!==false;const editToggle=$("medicineEditMode");if(editToggle)editToggle.checked=medicineModeEnabled;show("loginView",false);show("appView",true);$("userLabel").textContent=user.displayName||user.email;$("settingsEmail").textContent=user.email;try{await loadLocal();savedBills=await localDB.getAll("bills");}catch(err){console.warn("Local cache unavailable:",err);renderMedicines();}if(unsubscribe)unsubscribe();if(navigator.onLine){startCloudSync(user);flushQueue().catch(err=>console.warn("Pending sync will retry:",err));}status();}else{show("loginView",true);show("appView",false);if(unsubscribe){unsubscribe();unsubscribe=null;}if(historyUnsubscribe){historyUnsubscribe();historyUnsubscribe=null;}if(localDB){localDB.close();localDB=null;}medicines=[];savedBills=[];}});
$("logoutBtn").onclick=()=>signOut(auth);
$("addMedicineBtn").onclick=()=>openAddMedicine();
$("cancelMedicine").onclick=closeMedicineModal;$("medicineForm").onsubmit=saveMedicine;
$("medicineSearch").oninput=e=>renderMedicines(e.target.value);
$("billSearch").oninput=e=>renderBillSearch(e.target.value);
document.addEventListener("keydown",e=>{
 const billing=$("billingPage"),search=$("billSearch");
 if(!billing||billing.classList.contains("hidden")||!search||!$("appModal").classList.contains("hidden"))return;
 if(e.key.length!==1||e.ctrlKey||e.metaKey||e.altKey)return;
 const target=e.target;
 if(target===search||target?.isContentEditable||target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement||target instanceof HTMLSelectElement)return;
 if(target instanceof HTMLButtonElement&&e.key===" ")return;
 e.preventDefault();
 search.focus();
 const start=search.selectionStart??search.value.length,end=search.selectionEnd??search.value.length;
 search.setRangeText(e.key,start,end,"end");
 search.dispatchEvent(new Event("input",{bubbles:true}));
});
$("billSearch").addEventListener("keydown",e=>{
 if(!["ArrowDown","ArrowUp","Enter"].includes(e.key))return;
 const options=[...$("billMedicineList").querySelectorAll(".bill-option")];
 if(!options.length)return;
 if(e.key==="ArrowDown"||e.key==="ArrowUp"){
  e.preventDefault();
  const step=e.key==="ArrowDown"?1:-1;
  billSearchActiveIndex=billSearchActiveIndex<0?(step>0?0:options.length-1):(billSearchActiveIndex+step+options.length)%options.length;
  options.forEach((row,index)=>{const active=index===billSearchActiveIndex;row.classList.toggle("keyboard-active",active);row.setAttribute("aria-selected",String(active));});
  options[billSearchActiveIndex].scrollIntoView({block:"nearest",behavior:"auto"});
 }else{
  e.preventDefault();
  const index=billSearchActiveIndex<0?0:billSearchActiveIndex;
  const add=options[index]?.querySelector(".add-bill");
  if(add)add.click();
 }
});
$("discount").oninput=renderBill;
document.querySelectorAll(".nav[data-page]").forEach(b=>b.onclick=()=>{document.querySelectorAll(".nav[data-page]").forEach(x=>x.classList.toggle("active",x===b));["medicines","billing","history","settings"].forEach(p=>show(p+"Page",p===b.dataset.page));$("pageTitle").textContent=b.textContent.trim().replace(/^\S+\s*/,"");if(b.dataset.page==="billing")renderBillSearch();if(b.dataset.page==="history")startBillingHistory();});
function showBillValidation(errors){
 const patient=$("patientName"),items=$("billItems"),message=$("billMessage");
 patient.classList.toggle("field-error",errors.some(x=>x.field==="patient"));
 items.classList.toggle("bill-items-error",errors.some(x=>x.field==="items"));
 message.classList.toggle("validation-alert",errors.length>0);
 message.textContent=errors.length?errors.map(x=>x.text).join(" · "):"";
 if(errors.length){
  const first=errors[0].field==="patient"?patient:items;
  first.scrollIntoView({behavior:"smooth",block:"center"});
  if(errors[0].field==="patient")patient.focus({preventScroll:true});
 }
}
$("patientName").addEventListener("input",()=>{
 if($("patientName").value.trim())$("patientName").classList.remove("field-error");
 if(!$("patientName").classList.contains("field-error")&&!$("billItems").classList.contains("bill-items-error"))$("billMessage").classList.remove("validation-alert");
});
async function buildBillSnapshot(){
 const patientName=$("patientName").value.trim();
 const errors=[];
 if(!patientName)errors.push({field:"patient",text:"Add patient name"});
 if(!bill.length)errors.push({field:"items",text:"Add a medicine"});
 if(errors.length){showBillValidation(errors);return null;}
 showBillValidation([]);
 const subtotal=bill.reduce((sum,item)=>sum+Number(item.qty)*Number(item.price),0);
 const discount=Math.min(subtotal,Math.max(0,Number($("discount").value)||0));
 const rounding=bill.reduce((sum,item)=>sum+(item.adjustment||0),0);
 const finalTotal=Math.max(0,subtotal-discount)+rounding;
 const adjustedItems=bill.map(item=>{const lineTotal=Number(item.qty)*Number(item.price)+(item.adjustment||0);return {medicineId:item.id,name:item.name,unit:item.unit,quantity:Number(item.qty),unitPrice:lineTotal/Number(item.qty),originalUnitPrice:Number(item.price),lineAdjustment:item.adjustment||0,roundingAllowed:item.roundingAllowed===true,lineTotal};});
 const now=new Date();
 const previous=editingBillId?savedBills.find(x=>x.id===editingBillId):null;
 const receiptNumber=previous?.receiptNumber||await nextBillNumber();
 return {id:editingBillId||crypto.randomUUID(),receiptNumber,patientName,tokenNumber:$("tokenNumber").value.trim()||"",items:adjustedItems.map((item,index)=>({...item,itemNumber:index+1})),subtotal,discount,rounding,finalTotal,createdAt:previous?.createdAt||now.toISOString(),createdAtMillis:previous?.createdAtMillis||now.getTime(),ownerUid:currentUser.uid};
}
async function saveCurrentBill({printAfter=false}={}){
 if(!currentUser){$("billMessage").textContent="Please sign in again.";return;}
 $("saveBill").disabled=true;$("printBill").disabled=true;$("billMessage").classList.remove("validation-alert");$("billMessage").textContent="Saving bill…";
 try{
  const snapshot=await buildBillSnapshot();if(!snapshot)return;
  if(editingBillId&&!billEditAllowed({createdAtMillis:editingBillCreatedAt}))throw new Error("The 1-hour edit period has expired.");
  await localDB.put("bills",snapshot);await queueChange(snapshot.id,"set",snapshot,"bills");
  savedBills=[snapshot,...savedBills.filter(x=>x.id!==snapshot.id)].sort((a,b)=>(b.createdAtMillis||0)-(a.createdAtMillis||0));renderBillingHistory();
  const wasEditing=!!editingBillId;editingBillId=null;editingBillCreatedAt=0;$("saveBill").textContent="Save Bill";$("printBill").textContent="Save & Print";if(wasEditing){$("cancelBillEdit")?.remove();closeAppModal();}
  $("billMessage").textContent=(wasEditing?"Bill updated":"Bill saved")+(navigator.onLine?" locally; syncing…":" offline. It will sync when internet returns.")+" Receipt: "+snapshot.receiptNumber;
  if(navigator.onLine)flushQueue().then(()=>{$("billMessage").textContent="Bill saved and synced. Receipt: "+snapshot.receiptNumber;}).catch(console.warn);
  bill=[];$("patientName").value="";$("tokenNumber").value="";$("discount").value="0";roundingApplied=0;roundingBase=null;renderBill();
  if(printAfter){showReceipt(snapshot);printReceipt();}
 }catch(err){console.error("Save bill failed:",err);$("billMessage").classList.remove("validation-alert");$("billMessage").textContent="Bill could not be saved: "+(err?.message||"Unknown error");}
 finally{$("saveBill").disabled=false;$("printBill").disabled=false;}
}
$("saveBill").onclick=()=>saveCurrentBill();
$("printBill").onclick=()=>saveCurrentBill({printAfter:true});
function startBillingHistory(){
 if(!currentUser)return;
 if(historyUnsubscribe)historyUnsubscribe();
 localDB.getAll("bills").then(items=>{savedBills=items.sort((a,b)=>(b.createdAtMillis||0)-(a.createdAtMillis||0));renderBillingHistory();}).catch(console.warn);
 if(!navigator.onLine){$("billingHistoryList").innerHTML='<p class="muted">Offline — showing locally saved bills.</p>';return;}
 historyUnsubscribe=onSnapshot(collection(db,"users",currentUser.uid,"bills"),async snap=>{
  const pending=await localDB.getAll("pending"),billJobs=pending.filter(x=>x.collectionName==="bills"),pendingIds=new Set(billJobs.map(x=>x.targetId||x.id)),pendingDeletes=new Set(billJobs.filter(x=>x.type==="delete").map(x=>x.targetId||x.id));
  const cloud=snap.docs.map(d=>d.data()).filter(x=>!pendingDeletes.has(x.id));
  for(const item of cloud)if(!pendingIds.has(item.id))await localDB.put("bills",item);
  const local=await localDB.getAll("bills"),merged=new Map(cloud.map(x=>[x.id,x]));
  for(const item of local)if(pendingIds.has(item.id))merged.set(item.id,item);
  savedBills=[...merged.values()].sort((a,b)=>(b.createdAtMillis||0)-(a.createdAtMillis||0));renderBillingHistory();
 },err=>{console.warn("Billing history:",err);$("billingHistoryList").innerHTML='<p class="message">Cloud unavailable — local history remains available.</p>';});
}
function billDate(item){const raw=Number(item?.createdAtMillis)||Date.parse(item?.createdAt)||Date.now();const d=new Date(raw);return Number.isNaN(d.getTime())?new Date():d;}
function localDateKey(date){return [date.getFullYear(),String(date.getMonth()+1).padStart(2,"0"),String(date.getDate()).padStart(2,"0")].join("-");}
function dateHeading(date){const today=new Date(),yesterday=new Date();yesterday.setDate(today.getDate()-1);if(localDateKey(date)===localDateKey(today))return "Today";if(localDateKey(date)===localDateKey(yesterday))return "Yesterday";return date.toLocaleDateString(undefined,{weekday:"long",day:"numeric",month:"long",year:"numeric"});}
function renderBillingHistory(){
 const root=$("billingHistoryList");if(!root)return;
 const q=($("historySearch")?.value||"").trim().toLowerCase();
 const rows=savedBills.filter(x=>(x.receiptNumber||"").toLowerCase().includes(q)||(x.patientName||"").toLowerCase().includes(q));
 root.innerHTML="";
 if(syncNotice){const notice=document.createElement("p");notice.className="message";notice.textContent=syncNotice;const dismiss=document.createElement("button");dismiss.type="button";dismiss.className="tiny";dismiss.textContent="Dismiss";dismiss.onclick=()=>{syncNotice="";notice.remove();};notice.append(" ",dismiss);root.append(notice);}
 if(!rows.length){root.innerHTML+='<p class="muted">No saved bills found.</p>';return;}
 const groups=new Map();rows.sort((a,b)=>billDate(b)-billDate(a)).forEach(item=>{const date=billDate(item),key=localDateKey(date);if(!groups.has(key))groups.set(key,{date,items:[]});groups.get(key).items.push(item);});
 for(const group of groups.values()){
  const section=document.createElement("section");section.className="history-date-group";
  const heading=document.createElement("div");heading.className="history-date-heading";const label=document.createElement("b");label.textContent=dateHeading(group.date);const count=document.createElement("small");count.textContent=group.items.length+" "+(group.items.length===1?"bill":"bills");heading.append(label,count);section.append(heading);
  group.items.forEach(item=>{
   const row=document.createElement("div");row.className="history-row";row.tabIndex=0;row.setAttribute("role","button");row.setAttribute("aria-label","Open receipt "+(item.receiptNumber||""));const info=document.createElement("span");info.className="history-info";info.innerHTML="<b></b><small></small>";info.querySelector("b").textContent=item.patientName||"Patient";info.querySelector("small").textContent=(item.receiptNumber||"Receipt")+" · "+billDate(item).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
   const total=document.createElement("strong");total.textContent=money(item.finalTotal);row.append(info,total);row.onclick=()=>showReceipt(item);row.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();showReceipt(item);}};
   if(billEditAllowed(item)){const actions=document.createElement("span");actions.className="history-actions";const edit=document.createElement("button");edit.type="button";edit.className="tiny";edit.textContent="Edit";edit.onclick=e=>{e.stopPropagation();beginBillEdit(item);};const del=document.createElement("button");del.type="button";del.className="tiny danger";del.textContent="Delete";del.onclick=e=>{e.stopPropagation();deleteSavedBill(item);};actions.append(edit,del);row.append(actions);}section.append(row);
  });root.append(section);
 }
}
function billEditAllowed(item){const created=Number(item?.createdAtMillis)||0;return created>0&&Date.now()-created<3600000;}
function beginBillEdit(item){
 if(!billEditAllowed(item)){alert("This bill is locked after 1 hour.");renderBillingHistory();return;}
 editingBillId=item.id;editingBillCreatedAt=Number(item.createdAtMillis)||Date.now();
 $("patientName").value=item.patientName||"";$("tokenNumber").value=item.tokenNumber||"";$("discount").value=Number(item.discount)||0;
 bill=(item.items||[]).map(line=>({id:line.medicineId||crypto.randomUUID(),name:line.name,unit:line.unit||"Piece",qty:Number(line.quantity)||1,price:Number(line.originalUnitPrice??line.unitPrice)||0,roundingAllowed:line.roundingAllowed===true,adjustment:Number(line.lineAdjustment)||0}));
 $("saveBill").textContent="Update Bill";$("printBill").textContent="Update & Print";$("billMessage").textContent="";
 let cancel=$("cancelBillEdit");if(!cancel){cancel=document.createElement("button");cancel.id="cancelBillEdit";cancel.type="button";cancel.className="secondary";cancel.textContent="Cancel";$("billActions")?.append(cancel);if(!$("billActions"))$("saveBill").parentNode.append(cancel);}
 cancel.onclick=cancelBillEdit;
 renderBill();$("billMessage").textContent="Editing "+item.receiptNumber+" — only available during the first hour.";
 openAppModal(document.querySelector(".bill-panel"),"Edit Bill", "Update the patient, items or discount.","edit");
}
function cancelBillEdit(){
 editingBillId=null;editingBillCreatedAt=0;bill=[];$("patientName").value="";$("tokenNumber").value="";$("discount").value="0";
 $("saveBill").textContent="Save Bill";$("printBill").textContent="Save & Print";$("billMessage").textContent="";
 renderBill();closeAppModal();
}
async function deleteSavedBill(item){
 if(!billEditAllowed(item)){alert("This bill is locked after 1 hour.");return;}
 if(!await confirmAction("Delete bill","Delete receipt "+item.receiptNumber+"? This cannot be undone.","Delete bill"))return;
 try{await localDB.delete("bills",item.id);await queueChange(item.id,"delete",item,"bills");savedBills=savedBills.filter(x=>x.id!==item.id);renderBillingHistory();if(navigator.onLine)flushQueue().catch(console.warn);}
 catch(err){alert("Delete failed: "+err.message);}
}
function printReceipt(){
 const root=$("receiptDetail");if(!root)return;
 root.classList.add("printing-receipt");
 const history=$("historyPage");history.classList.remove("hidden");
 let cleaned=false;
 const cleanup=()=>{
  if(cleaned)return;cleaned=true;
  root.classList.remove("printing-receipt");
  if(!document.querySelector(".nav[data-page='history'].active"))history.classList.add("hidden");
  window.removeEventListener("afterprint",cleanup);
 };
 window.addEventListener("afterprint",cleanup,{once:true});
 window.print();
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
 const patient=document.createElement("strong");patient.className="receipt-patient";patient.textContent="PATIENT: "+(item.patientName||"—");
 const details=document.createElement("span");details.textContent=(item.tokenNumber?"Token: "+item.tokenNumber+" · ":"")+new Date(item.createdAtMillis||Date.now()).toLocaleString();
 meta.append(patient,details);root.append(meta);
 const table=document.createElement("div");table.className="receipt-lines";
 const head=document.createElement("div");head.className="receipt-line receipt-head";
 ["#","Medicine","Qty","Amount"].forEach(label=>{const cell=document.createElement("span");cell.textContent=label;head.append(cell);});
 table.append(head);
 (item.items||[]).forEach((line,index)=>{
  const row=document.createElement("div");row.className="receipt-line";
  const serial=document.createElement("span");serial.className="receipt-serial";serial.textContent=String(index+1);
  const number=document.createElement("span");number.className="receipt-number";number.textContent=String(line.itemNumber||table.children.length)+".";
  const name=document.createElement("span");name.className="receipt-medicine";name.textContent=line.name;
  const qty=document.createElement("span");qty.className="receipt-qty";qty.textContent=String(line.quantity)+" "+line.unit;
  const amount=document.createElement("b");amount.className="receipt-amount";amount.textContent=Number(line.lineTotal||0).toFixed(2);
  row.append(serial,name,qty,amount);table.append(row);
 });root.append(table);
 const summary=document.createElement("div");summary.className="receipt-summary";
 const addTotal=(label,value,kind="")=>{const row=document.createElement("div");row.className="receipt-summary-row"+(kind?" "+kind:"");const l=document.createElement("span");l.textContent=label;const v=document.createElement("b");v.textContent=Number(value||0).toFixed(2);row.append(l,v);summary.append(row);};
 if(Number(item.discount)>0){addTotal("Subtotal",item.subtotal);addTotal("Discount",item.discount,"discount");addTotal("TOTAL",item.finalTotal,"final");}
 else addTotal("TOTAL",item.finalTotal,"final");
 root.append(summary);
 const footer=document.createElement("p");footer.className="receipt-thanks";footer.textContent="Thank you. Get well soon!";root.append(footer);
 const receiptActions=document.createElement("div");receiptActions.className="receipt-detail-actions print-hide";
 if(billEditAllowed(item)){const edit=document.createElement("button");edit.type="button";edit.className="primary";edit.textContent="Edit bill";edit.onclick=()=>{closeAppModal();beginBillEdit(item);};const del=document.createElement("button");del.type="button";del.className="danger-button";del.textContent="Delete bill";del.onclick=async()=>{closeAppModal();await deleteSavedBill(item);};receiptActions.append(edit,del);}
 const print=document.createElement("button");print.type="button";print.className="secondary print-hide";print.textContent="Print receipt";print.onclick=printReceipt;receiptActions.append(print);root.append(receiptActions);
 openAppModal(root,"Bill "+item.receiptNumber,"Receipt details, edit and print options.","view");
}
$("historySearch").oninput=renderBillingHistory;
function setStatementDates(){const now=new Date(),mode=$("statementPeriod").value;let from=new Date(now),to=new Date(now);if(mode==="week"){const day=(now.getDay()+6)%7;from.setDate(now.getDate()-day);from.setHours(0,0,0,0);to.setHours(23,59,59,999);}else if(mode==="month"){from=new Date(now.getFullYear(),now.getMonth(),1);to=new Date(now.getFullYear(),now.getMonth()+1,0,23,59,59,999);}else if(mode==="lastMonth"){from=new Date(now.getFullYear(),now.getMonth()-1,1);to=new Date(now.getFullYear(),now.getMonth(),0,23,59,59,999);}else if(mode==="today"){from=new Date(now);from.setHours(0,0,0,0);to=new Date(now);to.setHours(23,59,59,999);} $("statementFrom").value=localDateKey(from);$("statementTo").value=localDateKey(to);$("statementCustomDates").classList.toggle("hidden",mode!=="custom");}
function openStatement(){show("statementModal",true);$("statementPreview").innerHTML='<p class="muted">Choose a period and select Generate statement.</p>';setStatementDates();}
function closeStatement(){show("statementModal",false);$("statementPrintArea").innerHTML="";}
function generateStatement(){
 const fv=$("statementFrom").value,tv=$("statementTo").value;if(!fv||!tv||fv>tv){$("statementPreview").innerHTML='<p class="message">Please select a valid date range.</p>';return;}
 const from=new Date(fv+"T00:00:00"),to=new Date(tv+"T23:59:59.999"),rows=savedBills.filter(x=>billDate(x)>=from&&billDate(x)<=to).sort((a,b)=>billDate(a)-billDate(b));
 const total=rows.reduce((s,x)=>s+(Number(x.finalTotal)||0),0),discount=rows.reduce((s,x)=>s+(Number(x.discount)||0),0),area=$("statementPrintArea");area.innerHTML="";
 const heading=document.createElement("div");heading.className="statement-print-heading";const brand=document.createElement("b"),sub=document.createElement("span"),period=document.createElement("small");brand.textContent="FRIENDS HOSPITAL PHARMACY";sub.textContent="BILLING STATEMENT";period.textContent=from.toLocaleDateString()+" — "+to.toLocaleDateString();heading.append(brand,sub,period);area.append(heading);
 const summary=document.createElement("div");summary.className="statement-summary";[["Total bills",String(rows.length)],["Total discount",money(discount)],["Net sales",money(total)]].forEach(([k,v])=>{const cell=document.createElement("div"),l=document.createElement("small"),b=document.createElement("b");l.textContent=k;b.textContent=v;cell.append(l,b);summary.append(cell);});area.append(summary);
 const table=document.createElement("table");table.className="statement-table";const thead=document.createElement("thead"),trh=document.createElement("tr");["Date & time","Receipt","Patient","Amount"].forEach(t=>{const th=document.createElement("th");th.textContent=t;trh.append(th);});thead.append(trh);table.append(thead);const tbody=document.createElement("tbody");
 rows.forEach(item=>{const tr=document.createElement("tr"),d=billDate(item);[d.toLocaleString(),item.receiptNumber||"—",item.patientName||"—",money(item.finalTotal)].forEach(v=>{const td=document.createElement("td");td.textContent=v;tr.append(td);});tbody.append(tr);});
 if(!rows.length){const tr=document.createElement("tr"),td=document.createElement("td");td.colSpan=4;td.textContent="No bills found in this date range.";tr.append(td);tbody.append(tr);}table.append(tbody);area.append(table);
 $("statementPreview").innerHTML="";const note=document.createElement("p");note.className="statement-result-note";note.textContent=rows.length+" bills · Net sales "+money(total);$("statementPreview").append(note);
}
$("statementBtn").onclick=openStatement;$("statementClose").onclick=closeStatement;$("statementPeriod").onchange=setStatementDates;$("statementGenerate").onclick=generateStatement;
$("statementPrint").onclick=()=>{if(!$("statementPrintArea").children.length)generateStatement();if($("statementPrintArea").children.length){document.body.classList.add("printing-statement");window.print();document.body.classList.remove("printing-statement");}};
$("statementModal").addEventListener("click",e=>{if(e.target===$("statementModal"))closeStatement();});

async function passwordDigest(password,salt){
 const material=await crypto.subtle.importKey("raw",new TextEncoder().encode(password),"PBKDF2",false,["deriveBits"]);
 const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt,iterations:180000,hash:"SHA-256"},material,256);
 return btoa(String.fromCharCode(...new Uint8Array(bits)));
}
async function saveEditModePassword(password){
 const salt=crypto.getRandomValues(new Uint8Array(16));
 const record={salt:btoa(String.fromCharCode(...salt)),hash:await passwordDigest(password,salt),iterations:180000};
 await localDB.put("meta",record,"medicineEditPassword");
}
async function verifyEditModePassword(password,record){
 try{const salt=Uint8Array.from(atob(record.salt),c=>c.charCodeAt(0));return (await passwordDigest(password,salt))===record.hash;}catch{return false;}
}
function editModePasswordDialog(setup=false){
 return new Promise(resolve=>{
  const box=document.createElement("div");box.className="edit-mode-password";
  const intro=document.createElement("p");intro.textContent=setup?"Create a separate password to protect medicine changes.":"Enter your Edit Mode password to unlock medicine changes.";
  const first=document.createElement("input");first.type="password";first.autocomplete=setup?"new-password":"current-password";first.placeholder=setup?"Create password (at least 6 characters)":"Edit Mode password";
  const second=document.createElement("input");second.type="password";second.autocomplete="new-password";second.placeholder="Confirm password";second.classList.toggle("hidden",!setup);
  const error=document.createElement("p");error.className="message";
  const actions=document.createElement("div");actions.className="modal-actions";
  const cancel=document.createElement("button"),submit=document.createElement("button");
  cancel.type=submit.type="button";cancel.className="secondary";submit.className="primary";
  cancel.textContent="Cancel";submit.textContent=setup?"Set password & Enable":"Unlock Edit Mode";
  cancel.onclick=()=>{closeAppModal();resolve(false);};
  submit.onclick=async()=>{
   error.textContent="";
   if(first.value.length<6){error.textContent="Password must be at least 6 characters.";first.focus();return;}
   if(setup&&first.value!==second.value){error.textContent="Passwords do not match.";second.focus();return;}
   submit.disabled=true;
   try{
    if(setup)await saveEditModePassword(first.value);
    else{const record=await localDB.get("meta","medicineEditPassword");if(!record||!await verifyEditModePassword(first.value,record)){error.textContent="Incorrect Edit Mode password. Try again or use Forgot password.";submit.disabled=false;first.focus();return;}}
    closeAppModal();resolve(true);
   }catch(err){error.textContent="Could not verify password: "+(err?.message||"Unknown error");submit.disabled=false;}
  };
  actions.append(cancel,submit);box.append(intro,first,second,error,actions);
  if(!setup){
   const forgot=document.createElement("button");forgot.type="button";forgot.className="text-button edit-mode-forgot";forgot.textContent="Forgot Edit Mode password?";
   forgot.onclick=()=>{
    const note=document.createElement("p");note.textContent="Request a password reset. After verifying your account, support will send you a recovery code within 24–48 hours.";
    const number=document.createElement("p");number.className="support-number";number.textContent="WhatsApp Support: +92 348 6314013";
    const contact=document.createElement("a");contact.className="primary full";contact.href="https://wa.me/"+SUPPORT_WHATSAPP+"?text="+encodeURIComponent("Friends Hospital Pharmacy: Please help me reset my Edit Mode password. Registered email: "+(currentUser?.email||""));contact.target="_blank";contact.rel="noopener noreferrer";contact.textContent="Contact on WhatsApp";
    const request=document.createElement("button");request.type="button";request.className="secondary full";request.textContent="Submit recovery request";
    const requestStatus=document.createElement("p");requestStatus.className="message";
    request.onclick=async()=>{
     if(!currentUser?.uid||!currentUser.email){requestStatus.textContent="Please sign in again before submitting a request.";return;}
     request.disabled=true;requestStatus.textContent="Submitting request…";
     try{
      await setDoc(doc(db,"editModeRecoveryRequests",currentUser.uid),{email:currentUser.email,requestedAt:serverTimestamp()});
      requestStatus.textContent="Request received. Support will contact you within 24–48 hours. Please also message us on WhatsApp.";
     }catch(err){requestStatus.textContent="Could not submit request: "+(err?.message||"Please try again.");}
     finally{request.disabled=false;}
    };
    const code=document.createElement("input");code.type="text";code.autocomplete="one-time-code";code.placeholder="Recovery code from support";
    const newPass=document.createElement("input");newPass.type="password";newPass.autocomplete="new-password";newPass.placeholder="New Edit Mode password (6+ characters)";
    const confirm=document.createElement("input");confirm.type="password";confirm.autocomplete="new-password";confirm.placeholder="Confirm new password";
    const msg=document.createElement("p");msg.className="message";
    const actions2=document.createElement("div");actions2.className="modal-actions";
    const back=document.createElement("button"),reset=document.createElement("button");back.type=reset.type="button";back.className="secondary";reset.className="primary";back.textContent="Back";reset.textContent="Verify & Reset";
    back.onclick=()=>{closeAppModal();resolve(false);};
    reset.onclick=async()=>{
     msg.textContent="";
     if(!code.value.trim()||newPass.value.length<6||newPass.value!==confirm.value){msg.textContent="Enter your recovery code and matching new passwords (at least 6 characters).";return;}
     reset.disabled=true;
     try{
      const approval=await getDoc(doc(db,"editModeRecoveryApprovals",currentUser.uid));
      if(!approval.exists())throw new Error("No approved recovery found. Please contact support.");
      const data=approval.data(),expiry=data.expiresAt;
      if(data.approved!==true||typeof data.codeHash!=="string"||!expiry?.toMillis||expiry.toMillis()<=Date.now())throw new Error("Recovery code is invalid or expired. Please contact support.");
      const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(code.value.trim())))).map(x=>x.toString(16).padStart(2,"0")).join("");
      if(digest!==data.codeHash)throw new Error("Incorrect recovery code. Please check and try again.");
      await saveEditModePassword(newPass.value);
      closeAppModal();resolve(true);
     }catch(err){msg.textContent=err?.message||"Recovery failed.";reset.disabled=false;}
    };
    actions2.append(back,reset);box.replaceChildren(intro,note,number,request,requestStatus,contact,code,newPass,confirm,msg,actions2);code.focus();
   };
   box.append(forgot);
  }
  openAppModal(box,setup?"Set Edit Mode Password":"Unlock Edit Mode",setup?"Create your medicine-edit security password.":"Verify your password to continue.","edit-password");
  first.focus();
 });
}
async function enableMedicineEditMode(){
 if(!currentUser||!localDB)return;
 const record=await localDB.get("meta","medicineEditPassword");
 const ok=await editModePasswordDialog(!record);
 if(!ok){$("medicineEditMode").checked=false;medicineModeEnabled=false;await localDB.put("meta",false,"medicineModeEnabled");renderMedicines($("medicineSearch").value);return;}
 medicineModeEnabled=true;$("medicineEditMode").checked=true;await localDB.put("meta",true,"medicineModeEnabled");renderMedicines($("medicineSearch").value);
}
$("medicineEditMode").onchange=async()=>{
 if($("medicineEditMode").checked){$("medicineEditMode").checked=false;await enableMedicineEditMode();return;}
 medicineModeEnabled=false;await localDB.put("meta",false,"medicineModeEnabled");if(modalKind==="medicine")closeMedicineModal();renderMedicines($("medicineSearch").value);
};
$("changeMedicineImage").onclick=()=>{if(!medicineModeEnabled)return;$("medicineImage").click();};
$("medicineImage").onchange=()=>{const file=$("medicineImage").files?.[0];if(!file){const existing=medicines.find(m=>m.id===$("medicineId").value);if(existing?.image)showMedicineImagePreview(existing.image);else resetMedicineImagePreview();return;}if(!file.type.startsWith("image/")){alert("Please select a valid image.");$("medicineImage").value="";return;}if(file.size>8*1024*1024){alert("Image must be 8 MB or smaller.");$("medicineImage").value="";return;}const reader=new FileReader();reader.onload=()=>{medicineImageRotation=0;medicineImageCrop=false;showMedicineImagePreview(reader.result);openMedicineImageEditor();};reader.readAsDataURL(file);};
$("saveName").onclick=async()=>{if(!currentUser)return;await updateProfile(currentUser,{displayName:$("displayName").value.trim()});$("userLabel").textContent=$("displayName").value.trim()||currentUser.email;};
$("exportData").onclick=async()=>{try{const [allMedicines,allBills]=await Promise.all([localDB.getAll("medicines"),localDB.getAll("bills")]);const blob=new Blob([JSON.stringify({version:2,exportedAt:new Date().toISOString(),medicines:allMedicines,bills:allBills},null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download="friends-pharmacy-backup.json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(err){alert("Backup export failed: "+err.message);}};

let installPrompt=null;function updateInstallButton(){const installed=window.matchMedia("(display-mode: standalone)").matches||window.navigator.standalone===true;show("installAppWrap",!!installPrompt&&!installed);}window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();installPrompt=e;updateInstallButton();});window.addEventListener("appinstalled",()=>{installPrompt=null;updateInstallButton();});$("installAppBtn").onclick=async()=>{if(!installPrompt)return;installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;updateInstallButton();};window.matchMedia("(display-mode: standalone)").addEventListener?.("change",updateInstallButton);if("serviceWorker" in navigator)window.addEventListener("load",()=>navigator.serviceWorker.register("./service-worker.js",{updateViaCache:"none"}).catch(err=>console.warn("Service worker:",err)));updateInstallButton();
$("importData").onchange=async e=>{
 const file=e.target.files?.[0];if(!file)return;
 const button=$("importData");button.disabled=true;
 try{
  if(!currentUser||!localDB)throw Error("Please sign in before importing a backup.");
  const data=JSON.parse(await file.text());
  if(!data||typeof data!=="object"||!Array.isArray(data.medicines))throw Error("Invalid backup file. Medicines data is missing.");
  if(data.bills!==undefined&&!Array.isArray(data.bills))throw Error("Invalid backup file. Bills data is not a valid list.");
  let importedMedicines=0,importedBills=0;
  for(const raw of data.medicines){
   if(!raw||!raw.id||!raw.name)continue;
   const medicine=normalizeMedicine({...raw,id:String(raw.id),name:String(raw.name).trim()});
   await localDB.put("medicines",medicine);
   await queueChange(medicine.id,"set",medicine,"medicines");
   importedMedicines++;
  }
  for(const raw of (data.bills||[])){
   if(!raw||!raw.id||!raw.receiptNumber)continue;
   const restored={...raw,id:String(raw.id),ownerUid:currentUser.uid,createdAtMillis:Number(raw.createdAtMillis)||Date.now()};
   await localDB.put("bills",restored);
   await queueChange(restored.id,"set",restored,"bills");
   importedBills++;
  }
  if(importedBills){
   const allBills=await localDB.getAll("bills");
   const maxNumber=allBills.reduce((max,item)=>Math.max(max,Number(String(item.receiptNumber||"").replace(/^B-/,""))||0),0);
   await localDB.put("meta",maxNumber,"billCounter");
  }
  medicines=await localDB.getAll("medicines");
  renderMedicines($("medicineSearch")?.value||"");
  if(navigator.onLine)await flushQueue();
  const pending=(await localDB.getAll("pending")).length;
  alert("Import complete: "+importedMedicines+" medicines and "+importedBills+" bills imported."+(pending?" "+pending+" item(s) are waiting to sync; check internet/Firebase permissions.":" Data synced."));
 }catch(err){
  console.error("Backup import failed:",err);
  alert("Import failed: "+(err?.message||"Unknown error"));
 }finally{
  button.disabled=false;e.target.value="";
 }
};
