import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, signOut, updateProfile, EmailAuthProvider, reauthenticateWithCredential } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, collection, doc, setDoc, getDoc, deleteDoc, onSnapshot, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getStorage, ref, uploadString, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import { openDB } from "https://cdn.jsdelivr.net/npm/idb@8/+esm";

const firebaseConfig={apiKey:"AIzaSyDu3T1shPJoooMNwhpPijfJsPaNc2JWWhM",authDomain:"friends-hospital-pharmacy.firebaseapp.com",projectId:"friends-hospital-pharmacy",storageBucket:"friends-hospital-pharmacy.firebasestorage.app",messagingSenderId:"277311494482",appId:"1:277311494482:web:84f77fd637d765c08f028b",measurementId:"G-RWBC6T7X1T"};
const app=initializeApp(firebaseConfig),auth=initializeAuth(app,{persistence:[indexedDBLocalPersistence,browserLocalPersistence,browserSessionPersistence]}),db=getFirestore(app),storage=getStorage(app),functions=getFunctions(app,"us-central1");
const SUPPORT_WHATSAPP="923486314013";
let localDB=null,accountEpoch="",authTransition=0,syncBlocked=false,syncOwnerUid=null;
async function openUserDB(uid){if(localDB){localDB.close();localDB=null;}const opened=await openDB("friends-pharmacy-"+uid,3,{upgrade(d){if(!d.objectStoreNames.contains("medicines"))d.createObjectStore("medicines",{keyPath:"id"});if(!d.objectStoreNames.contains("pending"))d.createObjectStore("pending",{keyPath:"id"});if(!d.objectStoreNames.contains("meta"))d.createObjectStore("meta");if(!d.objectStoreNames.contains("bills"))d.createObjectStore("bills",{keyPath:"id"});}});if(currentUser?.uid!==uid){opened.close();return;}localDB=opened;}
async function clearAccountLocalData(dbRef,epoch){for(const name of ["medicines","bills","pending","meta"])await dbRef.clear(name);if(epoch)await dbRef.put("meta",epoch,"dataEpoch");}
async function ensureAccountEpoch(uid,dbRef){
 let state=await getDoc(doc(db,"users",uid)),createdNow=false;
 if(!state.exists()){const fresh=crypto.randomUUID();await setDoc(doc(db,"users",uid),{dataEpoch:fresh,dataEpochUpdatedAt:serverTimestamp()});state=await getDoc(doc(db,"users",uid));createdNow=true;}
 const epoch=state.data()?.dataEpoch;if(typeof epoch!=="string"||!epoch)throw new Error("Account data version is missing. Cloud sync paused for safety.");
 const localEpoch=await dbRef.get("meta","dataEpoch");
 // A legacy local database may not have an epoch marker. Adopt the cloud
 // marker without deleting its existing medicines, bills, or pending queue.
 if(!localEpoch){await dbRef.put("meta",epoch,"dataEpoch");}
 else if(localEpoch!==epoch){
  syncBlocked=true;
  syncNotice="Local and cloud account versions differ. Local data is preserved; syncing is paused for safe recovery.";
  status();
  throw new Error(syncNotice);
 }
 accountEpoch=epoch;return epoch;
}
function resetAccountMemory(){medicines=[];bill=[];pendingBills=[];savedBills=[];refundReturns=[];refundPurchases=[];refundDraftLoaded=false;roundingApplied=0;roundingBase=null;editingBillId=null;editingBillCreatedAt=0;medicineModeEnabled=false;syncNotice="";syncBlocked=false;if($("medicineEditMode"))$("medicineEditMode").checked=false;for(const id of ["patientName","tokenNumber","refundPatientName","refundTokenNumber","discount"])if($(id))$(id).value=id==="discount"?"0":"";setDiscountEditor(false);renderBill();renderPendingBills();renderRefundWorkspace();renderMedicines();renderBillingHistory();}
let medicines=[],bill=[],unsubscribe=null,historyUnsubscribe=null,currentUser=null,roundingApplied=0,roundingBase=null,savedBills=[],editingBillId=null,editingBillCreatedAt=0,syncPromise=null,syncRetryTimer=null,syncRetryDelay=5000,syncNotice="",medicineModeEnabled=true,medicineImageDraft="",medicineImageRotation=0,medicineImageCrop=false,medicineVisibleCount=9,historyVisibleCount=9,historyObserver=null;
const asArray=value=>Array.isArray(value)?value:[];
const $=id=>document.getElementById(id),money=n=>"Rs. "+Number(n||0).toFixed(2),wholeMoney=n=>"Rs. "+Math.round(Number(n)||0).toLocaleString("en-PK"),medicinePriceText=n=>{const v=Number(n)||0;return "Rs. "+(Number.isInteger(v)?v.toLocaleString("en-PK"):String(v));};
const show=(id,yes)=>$(id).classList.toggle("hidden",!yes);
function setDiscountEditor(open){const toggle=$("discountToggle"),field=$("discountField");if(!toggle||!field)return;toggle.classList.toggle("hidden",open);field.classList.toggle("hidden",!open);toggle.setAttribute("aria-expanded",String(open));}
// Keep the discount editor open while a discount is entered; outside clicks must not erase it.

let toastTimer=null,toastRemaining=0,toastStarted=0;
function notify(message,type="success",duration=3600){
 let host=$("toastHost");if(!host){host=document.createElement("div");host.id="toastHost";host.className="toast-host";host.setAttribute("aria-live","polite");host.setAttribute("aria-atomic","true");document.body.append(host);}
 if(toastTimer)clearTimeout(toastTimer);
 const node=document.createElement("div");node.className="app-toast toast-"+type;
 const icon=document.createElement("span");icon.className="toast-icon";icon.textContent=type==="success"?"✓":type==="error"?"!":type==="warning"?"⚠":"✎";
 const textNode=document.createElement("span");textNode.className="toast-copy";textNode.textContent=message;
 const close=document.createElement("button");close.type="button";close.className="toast-close";close.setAttribute("aria-label","Dismiss notification");close.innerHTML='<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m18 6-12 12M6 6l12 12"/></svg>';
 const track=document.createElement("span");track.className="toast-progress";const bar=document.createElement("i");track.append(bar);node.append(icon,textNode,close,track);host.replaceChildren(node);
 toastRemaining=duration;let started=0;
 const dismiss=()=>{if(!node.isConnected)return;clearTimeout(toastTimer);toastTimer=null;node.classList.add("toast-leaving");setTimeout(()=>node.remove(),220);};
 const pause=()=>{if(!toastTimer)return;clearTimeout(toastTimer);toastTimer=null;toastRemaining=Math.max(0,toastRemaining-(performance.now()-started));bar.style.animationPlayState="paused";};
 const resume=()=>{if(!node.isConnected||toastTimer||toastRemaining<=0)return;started=performance.now();bar.style.animationDuration=toastRemaining+"ms";bar.style.animationPlayState="running";bar.style.animationName="toast-drain";bar.style.animationTimingFunction="linear";toastTimer=setTimeout(dismiss,toastRemaining);};
 bar.addEventListener("animationend",dismiss);node.addEventListener("mouseenter",pause);node.addEventListener("mouseleave",resume);node.addEventListener("focusin",pause);node.addEventListener("focusout",resume);close.onclick=dismiss;resume();
}

let modalNode=null,modalPlaceholder=null,modalKind="",billSearchActiveIndex=-1,refundSearchActiveIndex={return:-1,new:-1};
function openAppModal(node,title,subtitle="",kind="content"){
 if(!node)return;
 if(modalNode)closeAppModal();
 modalNode=node;modalKind=kind;modalPlaceholder=document.createComment("modal-origin");
 if(node.parentNode)node.parentNode.insertBefore(modalPlaceholder,node);else modalPlaceholder=null;
 $("appModalTitle").textContent=title;$("appModalSubtitle").textContent=subtitle;
 $("appModalDialog")?.classList.toggle("confirm-mode",kind==="confirm");$("appModalDialog")?.classList.toggle("bill-edit-mode",kind==="edit");
 $("appModalBody").replaceChildren(node);$("appModal").classList.remove("hidden");
 document.body.classList.add("modal-open");
}
function closeAppModal(){
 if(modalNode&&modalPlaceholder?.parentNode){modalPlaceholder.parentNode.insertBefore(modalNode,modalPlaceholder);modalPlaceholder.remove();}
 if(modalNode&&modalKind==="view")modalNode.classList.add("hidden");
 $("appModal").classList.add("hidden");$("appModalDialog")?.classList.remove("confirm-mode","bill-edit-mode");$("appModalBody").replaceChildren();
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
const RECOVERY_ADMIN_UID="Ud1gC1ZCaqZWSOhGPU63Wl26IzY2";
let recoveryAdminUnsubscribe=null;
function setupRecoveryAdmin(user){
 const header=document.querySelector(".main header"),settings=$("settingsPage")?.querySelector(".settings-panel");
 let bell=$("recoveryAdminBell"),link=$("recoveryAdminLink");
 if(user?.uid===RECOVERY_ADMIN_UID){
  if(!bell&&header){bell=document.createElement("button");bell.id="recoveryAdminBell";bell.type="button";bell.className="secondary";bell.style.cssText="margin-right:10px;min-height:38px;padding:7px 12px";bell.innerHTML="♢ <span id='recoveryAdminCount'>0</span>";bell.title="Pending recovery requests";header.insertBefore(bell,$("userLabel"));bell.onclick=()=>window.open("./recovery-admin.html","_blank","noopener");}
  if(!link&&settings){link=document.createElement("a");link.id="recoveryAdminLink";link.href="./recovery-admin.html";link.textContent="♢ Recovery Admin";link.style.cssText="display:inline-flex;margin:12px 0;padding:10px 14px;border-radius:10px;background:#e8f3ec;color:#176b55;font-weight:700;text-decoration:none";settings.insertBefore(link,settings.firstChild);}
  if(recoveryAdminUnsubscribe)recoveryAdminUnsubscribe();
  recoveryAdminUnsubscribe=onSnapshot(collection(db,"editModeRecoveryRequests"),snap=>{const count=$("recoveryAdminCount");if(count)count.textContent=String(snap.size);if(bell){bell.title=snap.size+" pending recovery request"+(snap.size===1?"":"s");bell.style.background=snap.size?"#dff3e6":"#edf5f0";}},err=>console.warn("Recovery notifications unavailable:",err));
 }else{if(bell)bell.remove();if(link)link.remove();if(recoveryAdminUnsubscribe){recoveryAdminUnsubscribe();recoveryAdminUnsubscribe=null;}}
}
function status(){ $("connection").textContent=syncBlocked?"● Cloud sync paused":navigator.onLine?"● Online / Firebase sync":"● Offline / Local mode";updatePendingPanel(); }
async function updatePendingPanel(){
 const countNode=$("pendingSyncCount"),listNode=$("pendingSyncList"),retry=$("retryPendingSync");if(!countNode||!listNode||!localDB)return;
 try{const jobs=await localDB.getAll("pending");countNode.textContent=String(jobs.length);listNode.replaceChildren();
  if(!jobs.length){const empty=document.createElement("p");empty.className="muted small-text";empty.textContent="No pending records. Everything is up to date.";listNode.append(empty);}
  else{for(const job of jobs.slice(0,30)){const row=document.createElement("div");row.className="pending-sync-row";const label=document.createElement("span");const group=job.collectionName==="bills"?"Bill":"Medicine";label.textContent=group+" · "+(job.data?.name||job.data?.receiptNumber||job.targetId||job.id);const state=document.createElement("b");state.textContent="Pending";row.append(label,state);listNode.append(row);}if(jobs.length>30){const more=document.createElement("p");more.className="muted small-text";more.textContent="And "+(jobs.length-30)+" more pending records.";listNode.append(more);}}
  if(retry)retry.disabled=!jobs.length||!navigator.onLine||syncBlocked;
 }catch(err){console.warn("Pending queue display:",err);}
}
$("retryPendingSync")?.addEventListener("click",async()=>{const btn=$("retryPendingSync");btn.disabled=true;try{syncBlocked=false;syncNotice="";status();await syncOnline();await flushQueue();await updatePendingPanel();const left=await localDB.getAll("pending");const line=left.length?left.length+" record(s) are still pending.":"All pending records synced successfully.";const node=$("importStatus");if(node){node.textContent=line;node.className="message "+(left.length?"warning":"success");}notify(line,left.length?"warning":"success",8000);}catch(err){console.error("Manual sync retry:",err);notify("Sync retry failed: "+(err?.message||"Unknown error"),"error",9000);}finally{await updatePendingPanel();}});
window.addEventListener("online",status);window.addEventListener("offline",status);status();
async function cacheAll(){const tx=localDB.transaction("medicines","readwrite");for(const m of medicines)if(m&&m.id)await tx.store.put(m);await tx.done;}
async function queueChange(id,type,data=null,collectionName="medicines"){const key=collectionName+":"+id;await localDB.put("pending",{id:key,targetId:id,collectionName,type,data,queuedAt:Date.now(),revision:crypto.randomUUID()});updatePendingPanel();}
async function reportQueuedWrite(id,collectionName,label){
 if(!navigator.onLine){notify(label+" saved on this device; waiting for internet to sync","info",4200);return;}
 try{await flushQueue();const pending=await localDB?.get("pending",collectionName+":"+id);notify(pending?label+" saved locally; Firebase sync is still pending":label+" synced successfully",pending?"warning":"success",4200);}
 catch(err){console.warn(label+" sync pending:",err);notify(label+" saved locally; cloud sync will retry when available","warning",4200);}
}
async function flushQueue(){if(!currentUser||!navigator.onLine||!localDB||syncBlocked)return;if(syncPromise&&syncOwnerUid!==currentUser.uid)await syncPromise.catch(()=>{});if(syncPromise)return syncPromise;const ownerUid=currentUser.uid,dbRef=localDB;syncOwnerUid=ownerUid;syncPromise=(async()=>{const epochSnap=await getDoc(doc(db,"users",ownerUid));const cloudEpoch=epochSnap.data()?.dataEpoch;if(!cloudEpoch||cloudEpoch!==accountEpoch){syncBlocked=true;syncNotice="Local and cloud account versions differ or are not initialized. Local records and pending uploads are preserved; syncing is paused for safe recovery.";status();throw new Error(syncNotice);}const jobs=(await dbRef.getAll("pending")).sort((a,b)=>a.queuedAt-b.queuedAt);for(const job of jobs){if(!navigator.onLine||!currentUser||currentUser.uid!==ownerUid||localDB!==dbRef)break;const group=job.collectionName||"medicines",targetId=job.targetId||job.id;let keepPending=false;try{const target=doc(db,"users",ownerUid,group,targetId);if(group==="bills"){const existing=await getDoc(target);if(job.type==="delete"){if(existing.exists())await deleteDoc(target);}else if(existing.exists()){await setDoc(target,{...job.data,createdAt:existing.data().createdAt||serverTimestamp()});}else{await setDoc(target,{...job.data,createdAt:serverTimestamp()});}}else if(group==="medicines"){if(job.type==="delete")await deleteDoc(target);else{let cloudMedicine={...job.data},imageUploadFailed=false;if(Array.isArray(cloudMedicine.packagings)){for(const pack of cloudMedicine.packagings){if(typeof pack.image==="string"&&pack.image.startsWith("data:")){try{const imageRef=ref(storage,"users/"+ownerUid+"/medicines/"+targetId+"/packagings/"+pack.id+".png");await uploadString(imageRef,pack.image,"data_url");pack.image=await getDownloadURL(imageRef);}catch(imageErr){console.warn("Medicine packing image sync pending:",targetId,imageErr);pack.image="";imageUploadFailed=true;}}}const current=cloudMedicine.packagings.find(p=>p.isCurrent);if(current)cloudMedicine.image=current.image||"";}if(typeof cloudMedicine.image==="string"&&cloudMedicine.image.startsWith("data:")){try{const imageRef=ref(storage,"users/"+ownerUid+"/medicines/"+targetId+".png");await uploadString(imageRef,cloudMedicine.image,"data_url");cloudMedicine.image=await getDownloadURL(imageRef);}catch(imageErr){console.warn("Medicine image sync pending:",targetId,imageErr);cloudMedicine.image="";imageUploadFailed=true;}}if(!imageUploadFailed&&localDB===dbRef){const latest=await dbRef.get("pending",job.id);if(latest&&(latest.revision||latest.queuedAt)===(job.revision||job.queuedAt))await dbRef.put("medicines",cloudMedicine);}await setDoc(target,cloudMedicine);keepPending=imageUploadFailed;}}else{if(job.type==="delete")await deleteDoc(target);else await setDoc(target,job.data);}if(localDB===dbRef&&currentUser?.uid===ownerUid){const latest=await dbRef.get("pending",job.id);if(!keepPending&&latest&&(latest.revision||latest.queuedAt)===(job.revision||job.queuedAt))await dbRef.delete("pending",job.id);}}catch(err){console.warn("Sync will retry:",err);if(err?.code==="permission-denied"){
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
 syncBlocked=true;syncNotice="Cloud sync is blocked by Firebase permissions. Pending data is preserved locally; check Firebase rules and configuration.";status();break;
}break;}}})().finally(()=>{syncPromise=null;syncOwnerUid=null;updatePendingPanel();if(syncRetryTimer){clearTimeout(syncRetryTimer);syncRetryTimer=null;}if(!syncBlocked&&currentUser?.uid===ownerUid&&navigator.onLine&&localDB===dbRef){dbRef.getAll("pending").then(jobs=>{if(jobs.length){const delay=syncRetryDelay;syncRetryDelay=Math.min(syncRetryDelay*2,60000);syncRetryTimer=setTimeout(()=>{if(currentUser?.uid===ownerUid&&navigator.onLine)syncOnline().catch(err=>console.warn("Scheduled sync retry:",err));},delay);}else syncRetryDelay=5000;}).catch(err=>console.warn("Could not inspect pending sync queue:",err));}});return syncPromise;}
async function syncOnline(){if(!currentUser||!navigator.onLine)return;if(!accountEpoch&&localDB)await ensureAccountEpoch(currentUser.uid,localDB);await flushQueue();if(!unsubscribe&&!syncBlocked)startCloudSync(currentUser);}
window.addEventListener("online",()=>{status();syncRetryDelay=5000;syncOnline().catch(err=>console.warn("Online sync:",err));});
window.addEventListener("pageshow",()=>{if(navigator.onLine)syncOnline().catch(err=>console.warn("Page-show sync:",err));});
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"&&navigator.onLine)syncOnline().catch(err=>console.warn("Visibility sync:",err));});
setInterval(()=>{if(navigator.onLine&&currentUser&&localDB)syncOnline().catch(err=>console.warn("Background sync check:",err));},30000);
async function nextBillNumber(){
 const localBills=localDB?await localDB.getAll("bills"):[];const maxLocal=localBills.reduce((n,x)=>Math.max(n,Number(String(x.receiptNumber||"").replace(/^B-/,""))||0),0);const current=Math.max(Number(await localDB.get("meta","billCounter"))||0,maxLocal);
 const next=current+1;
 await localDB.put("meta",next,"billCounter");
 return "B-"+String(next).padStart(6,"0");
}
async function loadLocal(){medicines=await localDB.getAll("medicines");renderMedicines();}
const UNIT_OPTIONS=["Tablet","Strip","Capsule","Injection","Bottle","Syrup","Packet","Box","Piece","Pack"];
function normalizeMedicine(m){if(!m||typeof m!=="object")return null;if(!m.unit||!Number.isFinite(Number(m.price))){const unit=Number(m.stripPrice)>0&&!Number(m.tabletPrice)?"Strip":"Tablet";m={...m,unit:m.unit||unit,price:Number(m.price??(unit==="Strip"?m.stripPrice:m.tabletPrice))||0};}const n={...m,tags:Array.isArray(m.tags)?m.tags:[],roundingAllowed:m.roundingAllowed===true};const medicineKey=String(n.id||"unknown");let p=Array.isArray(m.packagings)?m.packagings.filter(x=>x&&typeof x==="object").map((x,index)=>({...x,id:x.id||("packing-"+medicineKey+"-"+index),name:String(x.name||x.unit||"Packing"),unit:x.unit||n.unit,price:Math.max(0,Number(x.price??n.price)||0),image:typeof x.image==="string"?x.image:"",createdAt:Number(x.createdAt)||Number(m.updatedAt)||0,isCurrent:x.isCurrent===true})):[];if(!p.length&&n.image)p=[{id:"legacy-current-"+medicineKey,name:"Current Packing",unit:n.unit,price:n.price,image:n.image,createdAt:Number(m.updatedAt)||0,isCurrent:true}];if(p.length){const c=p.find(x=>x.isCurrent)||p[0];p=p.map(x=>({...x,isCurrent:x.id===c.id}));n.image=c.image||"";n.unit=c.unit||n.unit;n.price=Number(c.price)||0;}n.packagings=p;return n;}
function medicineMatches(m,q){if(!m||typeof m!=="object")return false;const term=String(q||"").trim().toLowerCase();return !term||[m.name,...asArray(m.tags)].some(v=>String(v||"").toLowerCase().includes(term));}
function appendSearchHighlight(target,value,query){target.textContent="";const text=String(value??""),term=String(query||"").trim();if(!term){target.textContent=text;return;}const lower=text.toLowerCase(),needle=term.toLowerCase();let cursor=0,index=0;while((index=lower.indexOf(needle,cursor))!==-1){target.append(document.createTextNode(text.slice(cursor,index)));const mark=document.createElement("mark");mark.className="search-match";mark.textContent=text.slice(index,index+term.length);target.append(mark);cursor=index+term.length;}target.append(document.createTextNode(text.slice(cursor)));}
function resetMedicineImagePreview(){medicineImageDraft="";medicineImageRotation=0;medicineImageCrop=false;const preview=$("medicineImagePreview");if(preview){preview.innerHTML="";preview.classList.add("hidden");}const picker=$("medicineImagePicker");if(picker)picker.classList.remove("has-image");const change=$("changeMedicineImage");if(change)change.innerHTML='<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m-4 4 4-4 4 4M20 16.5v2A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5v-2"/></svg><span>Upload image</span>';}
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
   showMedicineImagePreview(finalCanvas.toDataURL("image/png"));$("medicineImage").value="";medicineImageRotation=0;medicineImageCrop=false;overlay.remove();
  };source.onerror=()=>alert("Could not read this image.");source.src=medicineImageDraft;
 };
 actions.append(cancel,apply);wrap.append(preview,controls,note,actions);overlay.append(wrap);document.body.append(overlay);
}
function openAddMedicine(prefill=""){
 if(!medicineModeEnabled||!currentUser||!localDB)return;
 $("medicineForm").reset();$("medicineId").value="";$("medicineName").value=prefill;resetMedicineImagePreview();$("medicinePackagings")?.classList.add("hidden");$("medicineImageMode").value="replace";showNewPackingFields();
 $("medicineForm").querySelector('button[type="submit"]').textContent="Save medicine";
 show("medicineForm",true);openAppModal($("medicineForm"),"Add Medicine","Enter medicine details and optionally upload an image.","medicine");
 $("medicineName").focus();
}
function closeMedicineModal(){
 $("medicineForm").reset();$("medicineId").value="";resetMedicineImagePreview();$("medicinePackagings")?.classList.add("hidden");showNewPackingFields();
 $("medicineForm").querySelector('button[type="submit"]').textContent="Save medicine";
 closeAppModal();show("medicineForm",false);
}
function emptyAction(message,label,prefill=""){
 const box=document.createElement("div");box.className="empty-state";const title=document.createElement("b");title.textContent=message;box.append(title);
 if(medicineModeEnabled){const action=document.createElement("button");action.type="button";action.className="primary";action.innerHTML='<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span></span>';action.querySelector("span").textContent=String(label).replace(/^＋\s*/,"");action.onclick=()=>openAddMedicine(prefill);box.append(action);}return box;
}
let medicineViewMode="list";
function medicineSortTime(m){const value=m?.createdAt??m?.updatedAt??0;if(typeof value==="number")return value;if(value?.toMillis)return value.toMillis();const parsed=Date.parse(value);return Number.isFinite(parsed)?parsed:0;}
function setMedicineView(mode){medicineViewMode=mode==="grid"?"grid":"list";const list=$("medicineList");if(list)list.classList.toggle("grid-view",medicineViewMode==="grid");const listBtn=$("medicineListView"),gridBtn=$("medicineGridView");if(listBtn){listBtn.classList.toggle("active",medicineViewMode==="list");listBtn.setAttribute("aria-pressed",String(medicineViewMode==="list"));}if(gridBtn){gridBtn.classList.toggle("active",medicineViewMode==="grid");gridBtn.setAttribute("aria-pressed",String(medicineViewMode==="grid"));}renderMedicines($("medicineSearch")?.value||"");}
$("medicineListView")?.addEventListener("click",()=>setMedicineView("list"));$("medicineGridView")?.addEventListener("click",()=>setMedicineView("grid"));
function renderMedicines(filter=""){
 const list=$("medicineList");if(!list)return;list.innerHTML="";list.classList.toggle("grid-view",medicineViewMode==="grid");medicines=asArray(medicines).map(normalizeMedicine).filter(Boolean).sort((a,b)=>medicineSortTime(b)-medicineSortTime(a));$("addMedicineBtn").disabled=!medicineModeEnabled;$("addMedicineBtn").classList.toggle("hidden",!medicineModeEnabled);
 const count=$("medicineCount");if(count){count.querySelector("b").textContent=medicines.length.toLocaleString("en-PK");count.querySelector("span").textContent=medicines.length===1?"Medicine":"Medicines";}
 const filtered=medicines.filter(m=>medicineMatches(m,filter)),visible=filtered.slice(0,medicineVisibleCount);
 visible.forEach(m=>{
  const el=document.createElement("article");el.className="medicine-card"+(medicineViewMode==="grid"?" medicine-grid-card":"");
  const gridCard=medicineViewMode==="grid";
  const imageMarkup=m.image?'<img alt="">':'<div class="medicine-placeholder">✚</div>';
  const editMarkup='<button class="tiny edit" type="button"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg><span>Edit</span></button>';
  const deleteMarkup='<button class="tiny danger del" type="button" aria-label="Delete medicine" title="Delete medicine"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14M9 6V4h6v2m3 0-1 14H7L6 6m4 4v7m4-7v7"/></svg></button>';
  if(gridCard){
   el.innerHTML='<div class="medicine-media">'+imageMarkup+(medicineModeEnabled?deleteMarkup:'')+'</div><div class="medicine-card-details"><div class="medicine-info"><b></b><small class="medicine-meta"></small><span class="medicine-tags"></span></div>'+(medicineModeEnabled?'<div class="card-actions">'+editMarkup+'</div>':'')+'</div>';
  }else{
   el.innerHTML=imageMarkup+'<div class="medicine-info"><b></b><small class="medicine-meta"></small><span class="medicine-tags"></span></div>'+(medicineModeEnabled?'<div class="card-actions">'+editMarkup+deleteMarkup+'</div>':'');
  }
  if(m.image){const img=el.querySelector("img");img.src=m.image;img.loading="lazy";img.alt=m.name;}
  appendSearchHighlight(el.querySelector(".medicine-info b"),m.name,filter);el.querySelector(".medicine-meta").textContent=m.unit+" · "+medicinePriceText(m.price);
  const tagWrap=el.querySelector(".medicine-tags"),tagQuery=String(filter||"").trim().toLowerCase();if(tagQuery){asArray(m.tags).filter(tag=>String(tag||"").toLowerCase().includes(tagQuery)).forEach(tag=>{const chip=document.createElement("span");chip.className="medicine-tag";appendSearchHighlight(chip,tag,filter);tagWrap.append(chip);});}if(!tagWrap.childElementCount)tagWrap.remove();
  if(medicineModeEnabled){const edit=el.querySelector(".edit"),del=el.querySelector(".del");edit.type="button";del.type="button";edit.onclick=()=>editMedicine(m);del.onclick=()=>removeMedicine(m.id);}list.append(el);
 });
 if(!filtered.length){if(medicineModeEnabled)list.append(emptyAction(filter?"Medicine not found":"No medicines added yet",filter?"＋ Add new medicine":"＋ Add medicine",filter.trim()));else{const empty=document.createElement("div");empty.className="empty-state";const title=document.createElement("b");title.textContent=filter?"Medicine not found":"No medicines available";empty.append(title);list.append(empty);}}
 const more=$("loadMoreMedicines");if(more){const remaining=filtered.length-visible.length;more.classList.toggle("hidden",remaining<=0);more.textContent=remaining>0?"Load More · "+Math.min(9,remaining)+" more":"Load More";}
}
function askBillQuantity(m){
 if(!m||typeof m!=="object")return;bill=asArray(bill).filter(x=>x&&typeof x==="object");
 const box=document.createElement("div");box.className="quantity-prompt";
 const label=document.createElement("label");label.textContent="Quantity";
 const input=document.createElement("input");input.type="number";input.min="1";input.step="1";input.value="1";input.inputMode="numeric";input.className="quantity-prompt-input";
 const actions=document.createElement("div");actions.className="modal-actions";
 const cancel=document.createElement("button");cancel.type="button";cancel.className="secondary";cancel.textContent="Cancel";
 const add=document.createElement("button");add.type="button";add.className="primary";add.textContent="Add medicine";
 actions.append(cancel,add);box.append(label,input,actions);
 openAppModal(box,"Add Medicine",m.name+" · "+medicinePriceText(m.price??m.tabletPrice),"quantity");
 const finish=()=>closeAppModal();
 cancel.onclick=finish;
 add.onclick=()=>{
  const qty=Math.floor(Number(input.value));
  if(!Number.isFinite(qty)||qty<1){input.focus();return;}
  const existing=bill.find(x=>x.id===m.id);
  if(existing)existing.qty+=qty;
  else bill.push({id:m.id,name:m.name,unit:m.unit||"Tablet",qty,price:Number(m.price??m.tabletPrice)||0,roundingAllowed:m.roundingAllowed===true,adjustment:0});
  clearMedicineRounding();renderBill();persistActiveDraft().catch(console.warn);notify(m.name+" added to bill","success",2400);$("billSearch").value="";renderBillSearch("");finish();
  setTimeout(()=>{if($("billingPage")&&!$("billingPage").classList.contains("hidden")&&$("appModal").classList.contains("hidden")){$("billSearch").focus();$("billSearch").select();}},80);
 };
 input.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();add.click();}});
 setTimeout(()=>{input.focus();input.select();},0);
}
function renderBillSearch(q=""){
 const list=$("billMedicineList");if(!list)return;list.innerHTML="";billSearchActiveIndex=-1;medicines=asArray(medicines).filter(m=>m&&typeof m==="object");
 const matches=medicines.filter(m=>medicineMatches(m,q)).sort((a,b)=>String(a.name||"").localeCompare(String(b.name||""),undefined,{sensitivity:"base",numeric:true}));
 matches.forEach(m=>{
  const row=document.createElement("div");row.className="bill-option";row.setAttribute("role","option");row.setAttribute("aria-selected","false");
  const image=m.image?document.createElement("img"):document.createElement("div");
  image.className=m.image?"bill-medicine-image":"bill-medicine-placeholder";
  if(m.image){image.src=m.image;image.alt=m.name;image.loading="lazy";}
  else image.textContent="✚";
  const info=document.createElement("div");info.className="bill-medicine-info";info.innerHTML="<b></b><small></small>";
  appendSearchHighlight(info.querySelector("b"),m.name,q);
  const meta=info.querySelector("small");meta.textContent=(m.unit||"Tablet")+" · "+medicinePriceText(m.price??m.tabletPrice);
  const tagQuery=String(q||"").trim().toLowerCase();if(tagQuery){asArray(m.tags).filter(tag=>String(tag||"").toLowerCase().includes(tagQuery)).forEach(tag=>{const chip=document.createElement("span");chip.className="medicine-tag";appendSearchHighlight(chip,tag,q);info.append(chip);});}
  const btn=document.createElement("button");btn.type="button";btn.className="tiny add-bill";btn.innerHTML='<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>Add</span>';
  btn.onclick=()=>{notify(m.name+" selected","info",2200);askBillQuantity(m);};
  row.append(image,info,btn);list.append(row);
 });
 if(!matches.length){
  const box=document.createElement("div");box.className="empty-state";
  const title=document.createElement("b");title.textContent=medicines.length?(q.trim()?"Medicine not found":"No medicines available"):"Add your medicines before creating a bill.";
  box.append(title);
  if(medicineModeEnabled){
   const action=document.createElement("button");action.type="button";action.className="primary";action.innerHTML='<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>Add New Medicine</span>';
   action.onclick=()=>{document.querySelector('.nav[data-page="medicines"]').click();openAddMedicine(q.trim());};
   box.append(action);
  }
  box.classList.add("bill-search-empty");list.append(box);
 }
}
function roundingSuggestion(total){
 if(!Number.isFinite(total)||total<=0)return 0;
 // Up to 2499.99 -> next 50; 2500 through 4000 -> next 100.
 // Above 4000, retain the existing 500/1000-if-close, otherwise next-100 rule.
 const amount=Math.round(total*100)/100;
 const ceilMultiple=(value,step)=>Math.ceil((value-0.0000001)/step)*step;
 let target;
 if(amount<2500)target=ceilMultiple(amount,50);
 else if(amount<=4000)target=ceilMultiple(amount,100);
 else{
  const next500=ceilMultiple(amount,500);
  const difference=next500-amount;
  target=difference>0&&difference<=150?next500:ceilMultiple(amount,100);
 }
 return Math.max(0,Number((target-amount).toFixed(2)));
}
function clearMedicineRounding(){
 roundingApplied=0;roundingBase=null;
 bill.forEach(item=>{if(item.kind!=="custom")item.adjustment=0;});
}
function billItemTotal(item){return Math.max(0,Number(item?.qty)||0)*Math.max(0,Number(item?.price)||0)+(Number(item?.adjustment)||0);}
function openCustomItemForm(){
 const form=document.createElement("form");form.className="custom-item-form";form.noValidate=true;
 const nameLabel=document.createElement("label");nameLabel.className="custom-item-name-field";nameLabel.textContent="Item name";
 const name=document.createElement("input");name.type="text";name.maxLength=80;name.placeholder="e.g. Dressing Fee";name.required=true;name.autocomplete="off";nameLabel.append(name);
 const type=document.createElement("div");type.className="custom-item-type";type.setAttribute("role","group");type.setAttribute("aria-label","Charge type");
 let entryType="fixed";
 const fixedButton=document.createElement("button");fixedButton.type="button";fixedButton.className="custom-item-type-option";fixedButton.textContent="Fixed amount";
 const quantityButton=document.createElement("button");quantityButton.type="button";quantityButton.className="custom-item-type-option";quantityButton.textContent="By quantity";
 type.append(fixedButton,quantityButton);
 const amountLabel=document.createElement("label");amountLabel.className="custom-item-field";amountLabel.textContent="Total amount";
 const amount=document.createElement("input");amount.type="number";amount.min="0.01";amount.step="1";amount.placeholder="Rs. 500";amount.required=true;amountLabel.append(amount);
 const details=document.createElement("div");details.className="custom-item-quantity-fields hidden";
 const qtyLabel=document.createElement("label");qtyLabel.textContent="Quantity";
 const qty=document.createElement("input");qty.type="number";qty.min="1";qty.step="1";qty.value="1";qty.required=true;qtyLabel.append(qty);
 const unitLabel=document.createElement("label");unitLabel.textContent="Unit";
 const unit=document.createElement("select");UNIT_OPTIONS.forEach(value=>{const option=document.createElement("option");option.value=value;option.textContent=value;unit.append(option);});unit.value="Piece";unitLabel.append(unit);
 const priceLabel=document.createElement("label");priceLabel.textContent="Price per unit";
 const price=document.createElement("input");price.type="number";price.min="0.01";price.step="1";price.placeholder="Rs. 250";price.required=true;priceLabel.append(price);
 details.append(qtyLabel,unitLabel,priceLabel);
 const actions=document.createElement("div");actions.className="modal-actions custom-item-actions";
 const cancel=document.createElement("button");cancel.type="button";cancel.className="secondary";cancel.textContent="Cancel";
 const add=document.createElement("button");add.type="submit";add.className="primary";add.textContent="Add Item";
 actions.append(cancel,add);form.append(nameLabel,type,amountLabel,details,actions);
 function updateMode(){
  const quantityMode=entryType==="quantity";amountLabel.classList.toggle("hidden",quantityMode);details.classList.toggle("hidden",!quantityMode);
  amount.required=!quantityMode;qty.required=quantityMode;price.required=quantityMode;
  fixedButton.classList.toggle("active",!quantityMode);quantityButton.classList.toggle("active",quantityMode);
  fixedButton.setAttribute("aria-pressed",String(!quantityMode));quantityButton.setAttribute("aria-pressed",String(quantityMode));
 }
 fixedButton.onclick=()=>{entryType="fixed";updateMode();amount.focus();};
 quantityButton.onclick=()=>{entryType="quantity";updateMode();qty.focus();};
 cancel.onclick=()=>closeAppModal();
 form.addEventListener("submit",event=>{
  event.preventDefault();
  const itemName=name.value.trim();if(!itemName){name.focus();return;}
  let item;
  if(entryType==="fixed"){
   const total=Number(amount.value);if(!Number.isFinite(total)||total<=0){amount.focus();return;}
   item={id:crypto.randomUUID(),kind:"custom",name:itemName,unit:"Charge",qty:1,price:total,isFixedCharge:true,roundingAllowed:false,adjustment:0};
  }else{
   const quantity=Number(qty.value),unitPrice=Number(price.value);
   if(!Number.isInteger(quantity)||quantity<1){qty.focus();return;}
   if(!Number.isFinite(unitPrice)||unitPrice<=0){price.focus();return;}
   item={id:crypto.randomUUID(),kind:"custom",name:itemName,unit:unit.value,qty:quantity,price:unitPrice,isFixedCharge:false,roundingAllowed:false,adjustment:0};
  }
  bill.push(item);renderBill();persistActiveDraft().catch(console.warn);notify("Custom item added to bill","success",2400);closeAppModal();
 });
 updateMode();
 openAppModal(form,"Add Custom Item","Add a charge to this bill.","custom-item");
 setTimeout(()=>name.focus(),0);
}
function applyMedicineRounding(extra){
 bill=asArray(bill).filter(x=>x&&typeof x==="object");
 const extraCents=Math.round((Number(extra)||0)*100);
 if(extraCents<=0)return null;
 const eligible=bill.map((item,index)=>({item,index,lineCents:Math.round((Number(item.price||0)*Number(item.qty||0))*100)}))
  .filter(entry=>entry.item.kind!=="custom"&&entry.item.roundingAllowed).sort((a,b)=>b.lineCents-a.lineCents);
 if(!eligible.length)return null;
 const needed=entry=>((500-((entry.lineCents%500)+500)%500)%500);
 // Search every eligible medicine with dynamic programming, not a fixed 3-item limit.
 const reachable=new Map([[0,[]]]);
 for(const entry of eligible){
  const amount=needed(entry);
  const states=Array.from(reachable.entries());
  for(const [sum,chosen] of states){
   const nextSum=sum+amount;
   if(nextSum>extraCents)continue;
   const nextChosen=chosen.concat(entry);
   const existing=reachable.get(nextSum);
   if(!existing||nextChosen.length>existing.length)reachable.set(nextSum,nextChosen);
  }
 }
 let selected=null,selectedNeed=-1;
 for(const [sum,chosen] of reachable){
  if(chosen.length&&sum<=extraCents&&(extraCents-sum)%500===0&&chosen.length>(selected?.length||0)){
   selected=chosen;selectedNeed=sum;
  }
 }
 if(!selected)return null;
 const extraSteps=(extraCents-selectedNeed)/500;
 const adjusted=bill.map(item=>({...item,adjustment:0}));
 selected.forEach((entry,index)=>{
  const cents=needed(entry)+(index===0?extraSteps*500:0);
  adjusted[entry.index].adjustment=Number((cents/100).toFixed(2));
 });
 return adjusted;
}

let pendingBills=[];
function draftHasContent(){return bill.length>0||$("patientName").value.trim()||$("tokenNumber").value.trim()||Number($("discount").value)>0;}
function makeActiveDraft(){bill=asArray(bill).filter(x=>x&&typeof x==="object");return {patientName:$("patientName").value.trim(),tokenNumber:$("tokenNumber").value.trim(),discount:Number($("discount").value)||0,items:bill.map(x=>({...x})),roundingApplied,roundingBase,updatedAt:Date.now()};}
async function persistActiveDraft(){if(!localDB||editingBillId)return;const d=makeActiveDraft();if(draftHasContent())await localDB.put("meta",d,"activeBillDraft");else await localDB.delete("meta","activeBillDraft");}
async function loadPendingBills(){if(!localDB)return;pendingBills=asArray(await localDB.get("meta","pendingBills")).filter(item=>item&&typeof item==="object");renderPendingBills();}
async function persistPendingBills(){pendingBills=asArray(pendingBills).filter(item=>item&&typeof item==="object");if(localDB)await localDB.put("meta",pendingBills,"pendingBills");renderPendingBills();}
function renderPendingBills(){
 pendingBills=asArray(pendingBills).filter(item=>item&&typeof item==="object");const root=$("pendingBillsList"),count=$("pendingBillsCount");if(!root||!count)return;count.textContent=String(pendingBills.length);root.replaceChildren();
 if(!pendingBills.length){const p=document.createElement("p");p.className="pending-empty";p.textContent="No pending bills. Use Hold / Pending to keep a bill for later.";root.append(p);return;}
 pendingBills.slice().sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)).forEach(d=>{
  const card=document.createElement("article");card.className="pending-bill-card";card.tabIndex=0;card.setAttribute("role","button");card.setAttribute("aria-label","Open pending bill for "+(d.patientName||"unnamed patient"));card.title="Tap to open this pending bill";
  const info=document.createElement("div");info.className="pending-bill-info";
  const name=document.createElement("b");name.textContent=d.patientName||"Unnamed patient";const meta=document.createElement("small");meta.textContent=(d.items?.length||0)+" items · "+new Date(d.updatedAt||Date.now()).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
  const total=asArray(d.items).filter(x=>x&&typeof x==="object").reduce((s,x)=>s+billItemTotal(x),0)-Math.max(0,Number(d.discount)||0);
  const amountWrap=document.createElement("div");amountWrap.className="pending-bill-amount";
  const amount=document.createElement("strong");amount.textContent=wholeMoney(Math.max(0,total));
  const del=document.createElement("button");del.type="button";del.className="pending-delete";del.innerHTML='<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14M9 6V4h6v2m3 0-1 14H7L6 6m4 4v7m4-7v7"/></svg>';del.title="Delete pending bill";del.setAttribute("aria-label","Remove pending bill for "+(d.patientName||"unnamed patient"));
  del.onclick=async e=>{e.stopPropagation();if(!await confirmAction("Remove pending bill","Delete this temporarily held bill?","Delete"))return;pendingBills=pendingBills.filter(x=>x.id!==d.id);await persistPendingBills();notify("Pending bill removed","info");};
  amountWrap.append(amount,del);info.append(name,meta);card.append(info,amountWrap);
  card.onclick=()=>resumePendingBill(d.id);
  card.onkeydown=e=>{if(e.target===card&&(e.key==="Enter"||e.key===" ")){e.preventDefault();resumePendingBill(d.id);}};
  root.append(card);
 });
}
async function holdCurrentBill(){
 if(!draftHasContent())return false;
 if(editingBillId){notify("Finish or cancel the saved bill edit before holding another bill","warning");return false;}
 if(!$("patientName").value.trim()){showBillValidation([{field:"patient",text:"Patient name is required before holding this bill"}]);notify("Enter patient name before holding this bill","warning");return false;}
 pendingBills.unshift({id:crypto.randomUUID(),...makeActiveDraft()});await persistPendingBills();bill=[];$("patientName").value="";$("tokenNumber").value="";$("discount").value="0";setDiscountEditor(false);roundingApplied=0;roundingBase=null;await localDB.delete("meta","activeBillDraft");renderBill();$("billMessage").textContent="";$("billMessage").classList.remove("validation-alert");notify("Bill moved to Pending Bills","success");return true;
}
async function resumePendingBill(id){
 const d=pendingBills.find(x=>x.id===id);if(!d)return;
 if(draftHasContent()){const ok=await confirmAction("Hold current bill?","Your current bill has unsaved details. Hold it before opening this patient?","Hold & switch");if(!ok)return;const held=await holdCurrentBill();if(!held)return;}
 pendingBills=pendingBills.filter(x=>x.id!==id);await persistPendingBills();bill=asArray(d.items).filter(x=>x&&typeof x==="object").map(x=>({...x}));$("patientName").value=d.patientName||"";$("tokenNumber").value=d.tokenNumber||"";$("discount").value=String(d.discount||0);roundingApplied=Number(d.roundingApplied)||0;roundingBase=d.roundingBase??null;setDiscountEditor(Number(d.discount)>0);await localDB.delete("meta","activeBillDraft");$("billMessage").textContent="";$("billMessage").classList.remove("validation-alert");renderBill();notify("Pending bill opened","info");$("patientName").focus();
}

let quantityHoldTimer=null,quantityRepeatTimer=null,quantityHoldItem=null,quantityHoldDelta=0,quantitySuppressClick=false,quantityDraftChanged=false;
function stopQuantityHold(){
 if(quantityHoldTimer){clearTimeout(quantityHoldTimer);quantityHoldTimer=null;}
 if(quantityRepeatTimer){clearInterval(quantityRepeatTimer);quantityRepeatTimer=null;}
 quantityHoldItem=null;quantityHoldDelta=0;
}
function changeBillQuantity(item,delta){
 if(!bill.includes(item))return;
 item.qty=Math.max(1,Math.floor(Number(item.qty)||1)+delta);
 quantityDraftChanged=true;if(item.kind!=="custom")clearMedicineRounding();renderBill();
}
function startQuantityHold(event,item,delta){
 if(event.button!==undefined&&event.button!==0)return;
 event.preventDefault();
 stopQuantityHold();quantitySuppressClick=true;quantityHoldItem=item;quantityHoldDelta=delta;
 changeBillQuantity(item,delta);
 quantityHoldTimer=setTimeout(()=>{
  if(!quantityHoldItem)return;
  quantityRepeatTimer=setInterval(()=>changeBillQuantity(quantityHoldItem,quantityHoldDelta),90);
 },380);
}
function finishQuantityHold(){
 stopQuantityHold();
 if(quantityDraftChanged){quantityDraftChanged=false;persistActiveDraft().catch(console.warn);}
}
window.addEventListener("pointerup",finishQuantityHold);
window.addEventListener("pointercancel",finishQuantityHold);
window.addEventListener("blur",finishQuantityHold);
document.addEventListener("visibilitychange",()=>{if(document.hidden)stopQuantityHold();});

function renderBill(){
 const root=$("billItems");if(!root)return;bill=asArray(bill).filter(item=>item&&typeof item==="object");root.innerHTML="";
 if(bill.length){root.classList.remove("bill-items-error");if($("patientName").value.trim())$("billMessage").classList.remove("validation-alert");}
 if(!bill.length)root.innerHTML='<p class="muted">No items added yet.</p>';
 bill.forEach((it,i)=>{
  const custom=it.kind==="custom",fixed=custom&&it.isFixedCharge===true;
  const row=document.createElement("div");row.className="bill-row"+(custom?" custom-bill-row":"")+(fixed?" custom-fixed-row":"");
  const serial=document.createElement("span");serial.className="bill-item-serial";serial.textContent=String(i+1)+".";
  const name=document.createElement("span");name.className="bill-item-name";name.textContent=it.name;
  if(!custom&&Number(it.adjustment)>0){name.classList.add("rounding-adjusted");name.title="Rounding adjustment added to this medicine";}
  const unitLabel=document.createElement("small");unitLabel.className="bill-item-unit";unitLabel.textContent=fixed?"Fixed charge":(it.unit||"Piece");
  const nameWrap=document.createElement("span");nameWrap.className="bill-item-description";nameWrap.append(name,unitLabel);
  const controls=document.createElement("div");controls.className="qty-controls";
  if(fixed){controls.classList.add("custom-fixed-qty");controls.textContent="—";}
  else{
   const minus=document.createElement("button");minus.type="button";minus.className="qty-btn";minus.innerHTML='<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>';minus.setAttribute("aria-label","Decrease quantity");minus.title="Hold to decrease continuously";minus.addEventListener("pointerdown",e=>startQuantityHold(e,it,-1));minus.onclick=e=>{if(quantitySuppressClick){quantitySuppressClick=false;return;}if(e.detail===0){changeBillQuantity(it,-1);finishQuantityHold();}};
   const qty=document.createElement("input");qty.type="number";qty.min="1";qty.step="1";qty.value=it.qty;qty.setAttribute("aria-label","Quantity");qty.onchange=()=>{it.qty=Math.max(1,Math.floor(Number(qty.value)||1));if(it.kind!=="custom")clearMedicineRounding();renderBill();persistActiveDraft().catch(console.warn);};qty.addEventListener("keydown",e=>{if(e.key!=="Enter")return;e.preventDefault();it.qty=Math.max(1,Math.floor(Number(qty.value)||1));if(it.kind!=="custom")clearMedicineRounding();const nextIndex=Math.min(i+1,bill.length-1);renderBill();persistActiveDraft().catch(console.warn);requestAnimationFrame(()=>{const next=$("billItems").querySelectorAll(".qty-controls input")[nextIndex];if(next){next.focus();next.select();}});});
   const plus=document.createElement("button");plus.type="button";plus.className="qty-btn";plus.innerHTML='<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';plus.setAttribute("aria-label","Increase quantity");plus.title="Hold to increase continuously";plus.addEventListener("pointerdown",e=>startQuantityHold(e,it,1));plus.onclick=e=>{if(quantitySuppressClick){quantitySuppressClick=false;return;}if(e.detail===0){changeBillQuantity(it,1);finishQuantityHold();}};
   controls.append(minus,qty,plus);controls.classList.add("qty-controls-centered");
  }
  const price=document.createElement("b");price.className="bill-line-total";price.textContent=wholeMoney(billItemTotal(it));
  const del=document.createElement("button");del.type="button";del.className="remove-item";del.innerHTML='<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m18 6-12 12M6 6l12 12"/></svg>';del.title="Remove item";del.setAttribute("aria-label","Remove "+it.name);del.onclick=()=>{bill.splice(i,1);if(!custom)clearMedicineRounding();renderBill();persistActiveDraft().catch(console.warn);};
  row.append(serial,nameWrap,controls,price,del);root.append(row);
 });
 const sub=bill.reduce((sum,item)=>sum+Math.max(0,Number(item.qty)||0)*Math.max(0,Number(item.price)||0),0);
 const discount=Math.min(sub,Math.max(0,Number($("discount").value)||0));
 const base=Math.max(0,sub-discount);roundingBase=base;
 const currentAdjustment=bill.reduce((sum,item)=>sum+(item.kind==="custom"?0:(Number(item.adjustment)||0)),0);
 const eligible=bill.some(item=>item.kind!=="custom"&&item.roundingAllowed);
 const suggestion=currentAdjustment>0?0:roundingSuggestion(base);
 $("subtotal").textContent=wholeMoney(sub);$("roundingAmount").textContent=suggestion>0?"+ "+money(suggestion):"";
 $("roundingApply").classList.toggle("hidden",!(suggestion>0));$("roundingApply").disabled=!(suggestion>0&&eligible);$("roundingApply").textContent="Apply";
 $("roundingAppliedLabel").textContent=currentAdjustment>0?"Medicine prices adjusted: + "+money(currentAdjustment):(suggestion>0&&!eligible?"Rounding available — select at least one medicine marked “Rounding Allowed” to apply.":"");
 $("finalTotal").textContent=wholeMoney(base+currentAdjustment);
 $("roundingApply").onclick=()=>{
  if(!eligible){$("billMessage").textContent="Select a medicine marked Rounding Allowed first.";return;}
  const adjusted=applyMedicineRounding(suggestion);
  if(!adjusted){$("billMessage").textContent="No suitable medicine combination can apply this rounding. Add or select another Rounding Allowed medicine.";notify("No suitable medicine combination for clean rounding","warning");return;}
  bill=adjusted;roundingApplied=suggestion;$("billMessage").textContent="Rounding applied to selected medicine prices for this bill only.";renderBill();persistActiveDraft().catch(console.warn);
 };
}

async function saveMedicine(e){
 e.preventDefault();if(!medicineModeEnabled||!currentUser||!localDB)return;
 const id=$("medicineId").value||crypto.randomUUID(),old=medicines.find(m=>m.id===id),mode=old?$("medicineImageMode").value:"replace";
 let imageDraft=medicineImageDraft||"",file=$("medicineImage").files?.[0];
 if(file&&file.size>8*1024*1024){alert("Image must be 8 MB or smaller.");return;}
 if(file&&!imageDraft)imageDraft=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});
 const unit=$("medicineUnit").value,price=Math.max(0,Number($("medicinePrice").value)||0);let packs=old?normalizeMedicine(old).packagings.slice():[];
 if(!old){if(imageDraft)packs=[{id:crypto.randomUUID(),name:"Current Packing",unit,price,image:imageDraft,createdAt:Date.now(),isCurrent:true}];}
 else if(mode==="new"){
  if(!imageDraft){notify("Upload an image for the new packing first.","warning");$("medicineImage").click();return;}
  const label=$("newPackingName").value.trim(),priceText=$("newPackingPrice").value.trim(),newUnit=$("newPackingUnit").value,newPrice=Number(priceText);
  if(!label){notify("Enter a name for the new packing.","warning");$("newPackingName").focus();return;}
  if(!priceText||!Number.isFinite(newPrice)||newPrice<0){notify("Enter a valid new packing price.","warning");$("newPackingPrice").focus();return;}
  const current=packs.find(p=>p.isCurrent);if(current)current.isCurrent=false;
  if(!current&&old.image)packs.unshift({id:crypto.randomUUID(),name:"Previous Packing",unit:old.unit,price:old.price,image:old.image,createdAt:Date.now(),isCurrent:false});
  packs.push({id:crypto.randomUUID(),name:label,unit:newUnit,price:newPrice,image:imageDraft,createdAt:Date.now(),isCurrent:true});
 }else if(imageDraft){let current=packs.find(p=>p.isCurrent);if(!current){current={id:crypto.randomUUID(),name:"Current Packing",unit,price,image:"",createdAt:Date.now(),isCurrent:true};packs.push(current);}current.image=imageDraft;}
 const current=packs.find(p=>p.isCurrent);
 const m={id,name:$("medicineName").value.trim(),tags:[...new Set($("medicineTags").value.split(",").map(x=>x.trim()).filter(Boolean))],roundingAllowed:$("roundingAllowed").checked,unit:current?.unit||unit,price:current?Number(current.price)||0:price,image:current?.image||old?.image||"",packagings:packs,createdAt:Number(current?.createdAt)||Number(current?.updatedAt)||Date.now(),updatedAt:Date.now()};
 if(!m.name)return;medicines=medicines.filter(x=>x.id!==id).concat(m);await localDB.put("medicines",m);await queueChange(id,"set",m);
 renderMedicines($("medicineSearch").value);$("medicineForm").reset();$("medicineId").value="";resetMedicineImagePreview();$("medicineForm").querySelector('button[type="submit"]').textContent="Save medicine";closeAppModal();show("medicineForm",false);
 await reportQueuedWrite(id,"medicines",old?"Medicine updated":"Medicine saved");
}
function renderMedicinePackagings(m){
 const root=$("medicinePackagings");if(!root)return;root.replaceChildren();const packs=asArray(m?.packagings).filter(p=>p&&!p.isCurrent);
 if(!m||!packs.length){root.classList.add("hidden");return;}root.classList.remove("hidden");const heading=document.createElement("h4");heading.textContent="Saved previous packings";root.append(heading);
 packs.slice().sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).forEach(pack=>{
  const card=document.createElement("article");card.className="packing-history-card";const img=pack.image?document.createElement("img"):document.createElement("div");img.className="packing-history-image";
  if(pack.image){img.src=pack.image;img.alt=pack.name;img.loading="lazy";}else img.textContent="✚";
  const info=document.createElement("div");info.className="packing-history-info";const name=document.createElement("b");name.textContent=pack.name||"Previous Packing";const meta=document.createElement("small");meta.textContent=(pack.unit||"Unit")+" · "+medicinePriceText(pack.price);
  const actions=document.createElement("div");actions.className="packing-history-actions";const use=document.createElement("button");use.type="button";use.className="secondary";use.textContent="Use this packing";
  use.onclick=async()=>{const live=medicines.find(x=>x.id===m.id);if(!live)return;const next=normalizeMedicine(live),selected=next.packagings.find(p=>p.id===pack.id),current=next.packagings.find(p=>p.isCurrent);if(!selected)return;if(current)current.isCurrent=false;selected.isCurrent=true;next.unit=selected.unit;next.price=selected.price;next.image=selected.image||"";await persistMedicinePackingChange(next,"Packing switched. Billing will use its saved price.");};
  const del=document.createElement("button");del.type="button";del.className="tiny danger";del.textContent="Delete";
  del.onclick=async()=>{if(!await confirmAction("Delete saved packing","Delete this saved packing image and its saved price? This cannot be undone.","Delete packing"))return;const live=medicines.find(x=>x.id===m.id);if(!live)return;const next=normalizeMedicine(live);next.packagings=next.packagings.filter(p=>p.id!==pack.id);await persistMedicinePackingChange(next,"Saved packing deleted.");};
  actions.append(use,del);info.append(name,meta,actions);card.append(img,info);root.append(card);
 });
}
async function persistMedicinePackingChange(m,message){m.updatedAt=Date.now();medicines=medicines.map(x=>x.id===m.id?m:x);await localDB.put("medicines",m);await queueChange(m.id,"set",m);$("medicineUnit").value=m.unit;$("medicinePrice").value=m.price;if(m.image)showMedicineImagePreview(m.image);else resetMedicineImagePreview();renderMedicinePackagings(m);renderMedicines($("medicineSearch").value);await reportQueuedWrite(m.id,"medicines",message);}

function editMedicine(m){
 if(!medicineModeEnabled)return;
 m=normalizeMedicine(m);resetMedicineImagePreview();if(m.image)showMedicineImagePreview(m.image);$("medicineId").value=m.id;renderMedicinePackagings(m);$("medicineName").value=m.name;
 $("medicineUnit").value=m.unit;$("medicinePrice").value=m.price;
 $("medicineTags").value=(m.tags||[]).join(", ");$("roundingAllowed").checked=m.roundingAllowed===true;
 $("medicineForm").querySelector('button[type="submit"]').textContent="Update medicine";$("medicineImageMode").value="replace";$("newPackingName").value="";$("newPackingUnit").value=m.unit;$("newPackingPrice").value=m.price;showNewPackingFields();
 show("medicineForm",true);openAppModal($("medicineForm"),"Edit Medicine","Update medicine details or replace its uploaded image.","medicine");
}
async function removeMedicine(id){
 if(!medicineModeEnabled)return;
 if(!await confirmAction("Delete medicine","Are you sure you want to delete this medicine?","Delete medicine"))return;
 medicines=medicines.filter(m=>m.id!==id);await localDB.delete("medicines",id);
 await queueChange(id,"delete");renderMedicines($("medicineSearch").value);
 await reportQueuedWrite(id,"medicines","Medicine deleted");
}
function startCloudSync(user){
 if(unsubscribe)unsubscribe();
 const dbRef=localDB,ownerUid=user.uid;
 unsubscribe=onSnapshot(collection(db,"users",ownerUid,"medicines"),{includeMetadataChanges:true},async snap=>{
  if(!currentUser||currentUser.uid!==ownerUid||localDB!==dbRef)return;
  const pending=await dbRef.getAll("pending");
  if(!currentUser||currentUser.uid!==ownerUid||localDB!==dbRef)return;
  const pendingIds=new Set(pending.filter(x=>(x.collectionName||"medicines")==="medicines").map(x=>x.targetId||x.id));
  const local=asArray(await dbRef.getAll("medicines")).filter(m=>m&&typeof m==="object");
  if(!currentUser||currentUser.uid!==ownerUid||localDB!==dbRef)return;
  const cloud=snap.docs.map(d=>normalizeMedicine({...d.data(),id:d.id})).filter(m=>m&&m.id);
  const merged=new Map(cloud.map(m=>[m.id,m]));
  // Keep every local-only medicine. Pending local edits always win over cloud;
  // cloud wins only when there is no queued local change for that medicine.
  for(const m of local)if(pendingIds.has(m.id)||!merged.has(m.id))merged.set(m.id,m);
  medicines=[...merged.values()];
  // Never clear the IndexedDB store from a snapshot callback: imports and
  // offline-only records must survive while their queue is being processed.
  const tx=dbRef.transaction("medicines","readwrite");
  for(const m of medicines)await tx.store.put(m);
  await tx.done;
  if(!currentUser||currentUser.uid!==ownerUid||localDB!==dbRef)return;
  renderMedicines($("medicineSearch").value);await flushQueue();
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
onAuthStateChanged(auth,async user=>{const transition=++authTransition;currentUser=user;if(user){setupRecoveryAdmin(user);await openUserDB(user.uid);if(transition!==authTransition||!localDB||currentUser?.uid!==user.uid)return;const dbRef=localDB;try{await ensureAccountEpoch(user.uid,dbRef);if(transition!==authTransition||localDB!==dbRef)return;const savedEditPassword=await dbRef.get("meta","medicineEditPassword");medicineModeEnabled=!!savedEditPassword&&(await dbRef.get("meta","medicineModeEnabled"))!==false;const editToggle=$("medicineEditMode");if(editToggle)editToggle.checked=medicineModeEnabled;show("loginView",false);show("appView",true);$("userLabel").textContent=user.displayName||user.email;$("settingsEmail").textContent=user.email;await loadLocal();savedBills=await dbRef.getAll("bills");await loadPendingBills();const activeDraft=await dbRef.get("meta","activeBillDraft");if(activeDraft){bill=asArray(activeDraft.items).filter(x=>x&&typeof x==="object").map(x=>({...x}));$("patientName").value=activeDraft.patientName||"";$("tokenNumber").value=activeDraft.tokenNumber||"";$("discount").value=String(activeDraft.discount||0);roundingApplied=Number(activeDraft.roundingApplied)||0;roundingBase=activeDraft.roundingBase??null;setDiscountEditor(Number(activeDraft.discount)>0);renderBill();}const activeRefund=await dbRef.get("meta","activeRefundDraft");if(activeRefund){refundDraftLoaded=false;await loadRefundDraft();}}catch(err){console.error("Account initialization blocked:",err);if(transition!==authTransition||localDB!==dbRef)return;const networkFailure=!navigator.onLine||["unavailable","deadline-exceeded","auth/network-request-failed"].includes(err?.code);syncBlocked=!networkFailure;show("loginView",false);show("appView",true);$("userLabel").textContent=user.displayName||user.email;$("settingsEmail").textContent=user.email;try{await loadLocal();savedBills=await dbRef.getAll("bills");await loadPendingBills();}catch(localErr){console.warn("Local-only startup failed:",localErr);}notify(networkFailure?"Local records opened offline; cloud version check will retry when internet returns.":"Local records opened, but cloud sync is paused until Firebase rules and account version setup are deployed: "+(err?.message||"check Firebase"),"warning",7000);status();return;}if(transition!==authTransition||localDB!==dbRef)return;if(unsubscribe)unsubscribe();if(navigator.onLine){startCloudSync(user);flushQueue().catch(err=>console.warn("Pending sync will retry:",err));}status();}else{setupRecoveryAdmin(null);show("loginView",true);show("appView",false);if(unsubscribe){unsubscribe();unsubscribe=null;}if(historyUnsubscribe){historyUnsubscribe();historyUnsubscribe=null;}if(localDB){localDB.close();localDB=null;}resetAccountMemory();accountEpoch="";syncBlocked=false;}});

$("washAccountBtn").onclick=()=>{
 if(!currentUser||!currentUser.email||!localDB)return;
 const form=document.createElement("form");form.className="edit-mode-password";form.noValidate=true;
 const warning=document.createElement("p");warning.textContent="This permanently deletes this login's pharmacy data in Firebase and local records. Other devices will discard their old local data before syncing. Your login account remains active. This cannot be undone.";
 const phrase=document.createElement("input");phrase.placeholder='Type WASH to confirm';phrase.autocomplete="off";
 const password=document.createElement("input");password.type="password";password.placeholder="Confirm account password";password.autocomplete="current-password";
 const error=document.createElement("p");error.className="message";error.setAttribute("role","alert");
 const actions=document.createElement("div");actions.className="modal-actions";
 const cancel=document.createElement("button");cancel.type="button";cancel.className="secondary";cancel.textContent="Cancel";
 const submit=document.createElement("button");submit.type="submit";submit.className="danger-button";submit.textContent="Permanently wash data";
 cancel.onclick=()=>closeAppModal();form.append(warning,phrase,password,error,actions);actions.append(cancel,submit);
 form.onsubmit=async e=>{
  e.preventDefault();if(phrase.value.trim()!=="WASH"){error.textContent='Type exactly "WASH" to continue.';phrase.focus();return;}
  if(!password.value){error.textContent="Enter your login password.";password.focus();return;}
  submit.disabled=true;submit.textContent="Washing account data…";
  try{
   const user=currentUser,dbRef=localDB,uid=user.uid;
   await reauthenticateWithCredential(user,EmailAuthProvider.credential(user.email,password.value));
   const result=await httpsCallable(functions,"wipePharmacyData")({});
   if(currentUser?.uid!==uid||localDB!==dbRef)throw new Error("Account session changed. Sign in again and check data status.");
   const epoch=result.data?.dataEpoch;if(!result.data?.ok||typeof epoch!=="string")throw new Error("Server did not confirm the data wipe.");
   await clearAccountLocalData(dbRef,epoch);accountEpoch=epoch;resetAccountMemory();refundDraftLoaded=true;
   if(unsubscribe){unsubscribe();unsubscribe=null;}if(historyUnsubscribe){historyUnsubscribe();historyUnsubscribe=null;}
   closeAppModal();notify("Pharmacy data wiped. Your login account remains active.","success",6000);
   await loadLocal();await loadPendingBills();renderBillingHistory();renderRefundWorkspace();
  }catch(err){console.error("Account data wash failed:",err);error.textContent=err?.code==="auth/wrong-password"||err?.code==="auth/invalid-credential"?"Password verification failed.":(err?.message||"Data wash failed. Local records were not cleared.");submit.disabled=false;submit.textContent="Permanently wash data";}
 };
 openAppModal(form,"Wash Account Data","Permanent deletion across devices.","confirm");phrase.focus();
};
$("logoutBtn").onclick=()=>signOut(auth);
$("addMedicineBtn").onclick=()=>openAddMedicine();
$("cancelMedicine").onclick=closeMedicineModal;$("medicineForm").onsubmit=saveMedicine;
$("medicineSearch").oninput=e=>{medicineVisibleCount=9;renderMedicines(e.target.value);};
$("loadMoreMedicines").onclick=()=>{medicineVisibleCount+=9;renderMedicines($("medicineSearch").value);};
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
$("discount").oninput=()=>{if(Number($("discount").value)>0)setDiscountEditor(true);clearMedicineRounding();renderBill();persistActiveDraft().catch(console.warn);};$("discountToggle").onclick=()=>{setDiscountEditor(true);const field=$("discount");field.focus();field.select();};$("patientName").addEventListener("input",()=>persistActiveDraft().catch(console.warn));$("tokenNumber").addEventListener("input",()=>persistActiveDraft().catch(console.warn));$("patientName").addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();$("tokenNumber").focus();$("tokenNumber").select();}});$("tokenNumber").addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();const first=$("billItems").querySelector(".qty-controls input");if(first){first.focus();first.select();}else $("billSearch").focus();}});$("holdBill").onclick=holdCurrentBill;

let refundReturns=[],refundPurchases=[],refundDraftLoaded=false,refundSaving=false;
const refundLineTotal=line=>Math.max(0,Number(line.quantity)||0)*Math.max(0,Number(line.unitPrice)||0);
const refundTotals=()=>{
 const returned=refundReturns.reduce((sum,line)=>sum+refundLineTotal(line),0);
 const deduction=returned*.25,credit=returned-deduction;
 const purchases=refundPurchases.reduce((sum,line)=>sum+refundLineTotal(line),0);
 const net=purchases-credit;
 return {returned,deduction,credit,purchases,net,cashAmount:Math.abs(net),cashDirection:net>0?"collect":net<0?"refund":"settled"};
};
const refundMoney=value=>"Rs. "+Math.round(Number(value)||0).toLocaleString("en-PK");
async function persistRefundDraft(){
 if(!localDB)return;
 const draft={patientName:$("refundPatientName").value.trim(),tokenNumber:$("refundTokenNumber").value.trim(),returns:refundReturns.map(x=>({...x})),purchases:refundPurchases.map(x=>({...x})),updatedAt:Date.now()};
 if(draft.patientName||draft.tokenNumber||draft.returns.length||draft.purchases.length)await localDB.put("meta",draft,"activeRefundDraft");
 else await localDB.delete("meta","activeRefundDraft");
}
async function loadRefundDraft(){
 if(refundDraftLoaded||!localDB)return;
 const draft=await localDB.get("meta","activeRefundDraft");
 if(draft){
  $("refundPatientName").value=draft.patientName||"";
  $("refundTokenNumber").value=draft.tokenNumber||"";
  refundReturns=asArray(draft.returns).map(x=>({...x}));
  refundPurchases=asArray(draft.purchases).map(x=>({...x}));
 }
 refundDraftLoaded=true;renderRefundWorkspace();
}
function addRefundMedicine(target,medicine){
 target.push({id:crypto.randomUUID(),medicineId:medicine.id,name:medicine.name,unit:medicine.unit||"Tablet",quantity:1,unitPrice:Math.max(0,Number(medicine.price)||0)});
 renderRefundWorkspace();persistRefundDraft().catch(console.warn);
}
function renderRefundSearch(kind,query=""){
 const root=$(kind==="return"?"refundReturnResults":"refundNewResults");root.replaceChildren();
 const q=String(query||"").trim();refundSearchActiveIndex[kind]=-1;if(!q)return;
 const matches=medicines.filter(m=>medicineMatches(m,q)).sort((a,b)=>String(a.name||"").localeCompare(String(b.name||""),undefined,{sensitivity:"base",numeric:true})).slice(0,8);
 if(!matches.length){const empty=document.createElement("p");empty.className="refund-search-empty";empty.textContent="No matching medicine found.";root.append(empty);return;}
 matches.forEach(m=>{
  const button=document.createElement("button");button.type="button";button.className="refund-search-option";button.setAttribute("role","option");button.setAttribute("aria-selected","false");
  const name=document.createElement("span");name.textContent=m.name;
  const meta=document.createElement("small");meta.textContent=(m.unit||"Tablet")+" · "+medicinePriceText(m.price);
  const add=document.createElement("b");add.textContent="+";
  button.append(name,meta,add);
  button.onclick=()=>{addRefundMedicine(kind==="return"?refundReturns:refundPurchases,m);$(kind==="return"?"refundReturnSearch":"refundNewSearch").value="";root.replaceChildren();refundSearchActiveIndex[kind]=-1;};
  root.append(button);
 });
}
function renderRefundLines(kind){
 const isReturn=kind==="return",items=isReturn?refundReturns:refundPurchases,root=$(isReturn?"refundReturnLines":"refundNewLines");root.replaceChildren();
 if(!items.length){const p=document.createElement("p");p.className="refund-empty";p.textContent=isReturn?"No returned medicines added.":"No new medicines added. Leave empty for refund only.";root.append(p);return;}
 items.forEach((line,index)=>{
  const row=document.createElement("div");row.className="refund-line";
  const description=document.createElement("div");description.className="refund-line-description";
  const name=document.createElement("b");name.textContent=line.name;const unit=document.createElement("small");unit.textContent=line.unit;description.append(name,unit);
  const qty=document.createElement("input");qty.type="number";qty.min="1";qty.step="1";qty.value=String(line.quantity);qty.className="refund-qty";qty.setAttribute("aria-label","Quantity for "+line.name);
  qty.onchange=()=>{line.quantity=Math.max(1,Math.floor(Number(qty.value)||1));renderRefundWorkspace();persistRefundDraft().catch(console.warn);};
  const price=document.createElement("input");price.type="number";price.min="0";price.step="1";price.value=String(line.unitPrice);price.className="refund-price";price.readOnly=!isReturn;price.title=isReturn?"Confirm the price originally paid for this returned medicine":"Current medicine price";price.setAttribute("aria-label","Unit price for "+line.name);
  if(isReturn)price.onchange=()=>{line.unitPrice=Math.max(0,Number(price.value)||0);renderRefundWorkspace();persistRefundDraft().catch(console.warn);};
  const total=document.createElement("strong");total.className="refund-line-total";total.textContent=refundMoney(refundLineTotal(line));
  const remove=document.createElement("button");remove.type="button";remove.className="refund-remove";remove.textContent="×";remove.setAttribute("aria-label","Remove "+line.name);remove.onclick=()=>{items.splice(index,1);renderRefundWorkspace();persistRefundDraft().catch(console.warn);};
  const pricing=document.createElement("div");pricing.className="refund-line-pricing";pricing.append(qty,price,total,remove);
  row.append(description,pricing);root.append(row);
 });
}
function renderRefundWorkspace(){
 if(!$("refundReturnLines"))return;
 renderRefundLines("return");renderRefundLines("new");
 const t=refundTotals();
 $("refundReturnTotal").textContent=refundMoney(t.returned);$("refundNewTotal").textContent=refundMoney(t.purchases);
 $("refundSubtotal").textContent=refundMoney(t.returned);$("refundDeduction").textContent="− "+refundMoney(t.deduction);$("refundCredit").textContent=refundMoney(t.credit);$("refundPurchaseTotal").textContent=refundMoney(t.purchases);
 $("refundNetLabel").textContent=t.cashDirection==="collect"?"Amount to collect":t.cashDirection==="refund"?"Cash refund to patient":"No cash difference";
 $("refundNetHint").textContent=t.cashDirection==="collect"?"Patient pays":t.cashDirection==="refund"?"Pay patient":"Settled";
 $("refundNetAmount").textContent=refundMoney(t.cashAmount);
 $("refundNetAmount").classList.toggle("refund-pay",t.cashDirection==="collect");
 $("refundNetAmount").classList.toggle("refund-cashout",t.cashDirection==="refund");
 $("saveRefund").disabled=refundSaving||!refundReturns.length||!$("refundPatientName").value.trim();
}
async function nextRefundNumber(){
 const current=Number(await localDB.get("meta","refundCounter"))||0,next=current+1;
 await localDB.put("meta",next,"refundCounter");return "R-"+String(next).padStart(6,"0");
}
async function saveRefundTransaction(){
 if(refundSaving)return;
 if(!$("refundPatientName").value.trim()){ $("refundPatientName").focus();notify("Enter patient name first","warning");return;}
 if(!refundReturns.length){$("refundReturnSearch").focus();notify("Add at least one returned medicine","warning");return;}
 const totals=refundTotals();refundSaving=true;renderRefundWorkspace();$("refundMessage").textContent="Saving transaction…";
 try{
  const now=new Date(),id=crypto.randomUUID(),receiptNumber=await nextRefundNumber();
  const toSnapshot=lines=>lines.map((line,index)=>({kind:"medicine",medicineId:line.medicineId,name:line.name,unit:line.unit,quantity:Number(line.quantity),unitPrice:Number(line.unitPrice),lineTotal:refundLineTotal(line),itemNumber:index+1}));
  const transaction={id,receiptNumber,transactionType:"refund",transactionKind:!refundPurchases.length?"refund-only":totals.cashDirection==="settled"?"exchange-settled":totals.cashDirection==="collect"?"purchase-with-refund-credit":"exchange-with-cash-refund",patientName:$("refundPatientName").value.trim(),tokenNumber:$("refundTokenNumber").value.trim(),refundItems:toSnapshot(refundReturns),newItems:toSnapshot(refundPurchases),returnedSubtotal:totals.returned,deductionRate:.25,deductionAmount:totals.deduction,refundCredit:totals.credit,newSubtotal:totals.purchases,netAmount:totals.net,cashDirection:totals.cashDirection,cashAmount:totals.cashAmount,finalTotal:totals.net,createdAt:now.toISOString(),createdAtMillis:now.getTime(),ownerUid:currentUser.uid};
  await localDB.put("bills",transaction);await queueChange(id,"set",transaction,"bills");
  savedBills=[transaction,...savedBills.filter(x=>x.id!==id)].sort((x,y)=>(y.createdAtMillis||0)-(x.createdAtMillis||0));renderBillingHistory();
  refundReturns=[];refundPurchases=[];$("refundPatientName").value="";$("refundTokenNumber").value="";$("refundMessage").textContent="";
  await localDB.delete("meta","activeRefundDraft");renderRefundWorkspace();
  if(navigator.onLine){try{await flushQueue();const stillPending=(await localDB.getAll("pending")).some(job=>(job.collectionName||"medicines")==="bills"&&(job.targetId||job.id)===id);notify(stillPending?"Refund saved locally; Firebase sync is still pending · "+receiptNumber:"Refund synced successfully · "+receiptNumber,stillPending?"warning":"success",4200);}catch(syncErr){console.warn("Refund sync pending:",syncErr);notify("Refund saved locally; cloud sync will retry when available","warning",4200);}}
  else notify("Refund saved on this device; waiting for internet to sync","info",4200);
  showReceipt(transaction);
 }catch(error){console.error("Refund transaction failed:",error);$("refundMessage").textContent="Could not save: "+(error?.message||"Please try again");notify("Transaction could not be saved","error",4200);}
 finally{refundSaving=false;renderRefundWorkspace();}
}
function clearRefundWorkspace(){
 if(!refundReturns.length&&!refundPurchases.length&&!$("refundPatientName").value.trim()&&!$("refundTokenNumber").value.trim())return;
 confirmAction("Clear refund workspace","Remove all returned and new medicines from this unsaved transaction?","Clear all").then(async ok=>{
  if(!ok)return;refundReturns=[];refundPurchases=[];$("refundPatientName").value="";$("refundTokenNumber").value="";$("refundReturnSearch").value="";$("refundNewSearch").value="";$("refundReturnResults").replaceChildren();$("refundNewResults").replaceChildren();await localDB.delete("meta","activeRefundDraft");renderRefundWorkspace();
 });
}
$("refundReturnSearch").oninput=e=>renderRefundSearch("return",e.target.value);
$("refundNewSearch").oninput=e=>renderRefundSearch("new",e.target.value);
[["return","refundReturnSearch","refundReturnResults"],["new","refundNewSearch","refundNewResults"]].forEach(([kind,inputId,listId])=>{
 $(inputId).addEventListener("keydown",e=>{
  if(!["ArrowDown","ArrowUp","Enter"].includes(e.key))return;
  const options=[...$(listId).querySelectorAll(".refund-search-option")];if(!options.length)return;
  if(e.key==="ArrowDown"||e.key==="ArrowUp"){
   e.preventDefault();const step=e.key==="ArrowDown"?1:-1;
   refundSearchActiveIndex[kind]=refundSearchActiveIndex[kind]<0?(step>0?0:options.length-1):(refundSearchActiveIndex[kind]+step+options.length)%options.length;
   options.forEach((row,index)=>{const active=index===refundSearchActiveIndex[kind];row.classList.toggle("keyboard-active",active);row.setAttribute("aria-selected",String(active));});
   options[refundSearchActiveIndex[kind]].scrollIntoView({block:"nearest",behavior:"auto"});
  }else{e.preventDefault();options[refundSearchActiveIndex[kind]<0?0:refundSearchActiveIndex[kind]]?.click();}
 });
});
["refundPatientName","refundTokenNumber"].forEach(id=>$(id).addEventListener("input",()=>{renderRefundWorkspace();persistRefundDraft().catch(console.warn);}));
$("saveRefund").onclick=saveRefundTransaction;$("clearRefund").onclick=clearRefundWorkspace;

document.querySelectorAll(".nav[data-page]").forEach(b=>b.onclick=()=>{document.querySelectorAll(".nav[data-page]").forEach(x=>x.classList.toggle("active",x===b));["medicines","billing","history","refund","settings"].forEach(p=>show(p+"Page",p===b.dataset.page));$("pageTitle").textContent=b.textContent.trim().replace(/^\S+\s*/,"");if(b.dataset.page==="billing")renderBillSearch();if(b.dataset.page==="history")startBillingHistory();if(b.dataset.page==="refund")loadRefundDraft().catch(console.warn);});
function showBillValidation(errors){
  const patient=$("patientName"),items=$("billItems"),message=$("billMessage");
  const needsPatient=errors.some(x=>x.field==="patient");
  patient.classList.toggle("field-error",needsPatient);
  items.classList.remove("bill-items-error");
  message.classList.remove("validation-alert");
  message.textContent="";
  if(needsPatient){patient.scrollIntoView({behavior:"smooth",block:"center"});patient.focus({preventScroll:true});}
 }
$("patientName").addEventListener("input",()=>{
 if($("patientName").value.trim())$("patientName").classList.remove("field-error");
 if(!$("patientName").classList.contains("field-error")&&!$("billItems").classList.contains("bill-items-error"))$("billMessage").classList.remove("validation-alert");
});
async function buildBillSnapshot(){
 bill=asArray(bill).filter(item=>item&&typeof item==="object");savedBills=asArray(savedBills).filter(item=>item&&typeof item==="object");
 const patientName=$("patientName").value.trim();
 const errors=[];
 if(!patientName)errors.push({field:"patient",text:"Add patient name"});
 if(!bill.length)errors.push({field:"items",text:"Add an item"});
 if(errors.length){showBillValidation(errors);notify(errors.map(x=>x.text).join(" · "),"warning");return null;}
 showBillValidation([]);
 const subtotal=bill.reduce((sum,item)=>sum+Math.max(0,Number(item.qty)||0)*Math.max(0,Number(item.price)||0),0);
 const discount=Math.min(subtotal,Math.max(0,Number($("discount").value)||0));
 const rounding=bill.reduce((sum,item)=>sum+(item.kind==="custom"?0:(Number(item.adjustment)||0)),0);
 const finalTotal=Math.max(0,subtotal-discount)+rounding;
 const adjustedItems=bill.map(item=>{const quantity=Math.max(1,Number(item.qty)||1),lineTotal=billItemTotal(item);return {kind:item.kind==="custom"?"custom":"medicine",...(item.kind==="custom"?{}:{medicineId:item.id}),name:item.name,unit:item.unit||"",quantity,unitPrice:Number(item.price)||0,originalUnitPrice:Number(item.price)||0,isFixedCharge:item.kind==="custom"&&item.isFixedCharge===true,lineAdjustment:item.kind==="custom"?0:(Number(item.adjustment)||0),roundingAllowed:item.kind!=="custom"&&item.roundingAllowed===true,lineTotal};});
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
  const wasEditing=!!editingBillId;editingBillId=null;editingBillCreatedAt=0;$("saveBill").textContent="Save";$("printBill").textContent="Save & Print";if(wasEditing){$("cancelBillEdit")?.remove();closeAppModal();}
  $("billMessage").textContent="";
  if(navigator.onLine)flushQueue().then(async()=>{const stillPending=(await localDB.getAll("pending")).some(job=>(job.collectionName||"medicines")==="bills"&&(job.targetId||job.id)===snapshot.id);if(stillPending)notify("Bill saved on this device; Firebase sync is still pending · "+snapshot.receiptNumber,"warning",4200);else notify("Bill synced successfully · "+snapshot.receiptNumber,"success",2600);}).catch(err=>{console.warn("Bill sync pending:",err);notify("Bill saved on this device; sync will retry when online","warning",4200);});
  else notify("Bill saved on this device; waiting for internet to sync","info",3600);
  bill=[];$("patientName").value="";$("tokenNumber").value="";$("discount").value="0";setDiscountEditor(false);roundingApplied=0;roundingBase=null;await localDB.delete("meta","activeBillDraft");renderBill();notify((wasEditing?"Bill updated: ":"Bill saved: ")+snapshot.receiptNumber,"success");
  if(printAfter){showReceipt(snapshot);printReceipt();notify("Receipt ready to print: "+snapshot.receiptNumber,"success");}
 }catch(err){console.error("Save bill failed:",err);$("billMessage").classList.remove("validation-alert");$("billMessage").textContent="Bill could not be saved: "+(err?.message||"Unknown error");notify("Bill could not be saved: "+(err?.message||"Please try again"),"error",5200);}
 finally{$("saveBill").disabled=false;$("printBill").disabled=false;}
}
$("saveBill").onclick=()=>saveCurrentBill();
$("printBill").onclick=()=>saveCurrentBill({printAfter:true});
function setHistoryLoading(loading){const root=$("billingHistoryList");if(!root)return;root.classList.toggle("history-loading-content",loading);let overlay=$("historyLoadingOverlay");if(loading){if(!overlay){overlay=document.createElement("div");overlay.id="historyLoadingOverlay";overlay.className="history-loading-overlay";overlay.innerHTML='<div class="history-loading-card"><span class="history-spinner"></span><b>Loading billing history…</b></div>';root.parentElement?.append(overlay);}}else if(overlay)overlay.remove();}
function startBillingHistory(){
 if(!currentUser)return;historyVisibleCount=9;if(historyObserver){historyObserver.disconnect();historyObserver=null;}
 if(historyUnsubscribe)historyUnsubscribe();
 setHistoryLoading(true);
 if(!navigator.onLine){localDB.getAll("bills").then(items=>{savedBills=items.sort((a,b)=>(b.createdAtMillis||0)-(a.createdAtMillis||0));renderBillingHistory();$("billingHistoryList").insertAdjacentHTML("afterbegin",'<p class="muted">Offline — showing locally saved bills.</p>');setHistoryLoading(false);}).catch(err=>{console.warn(err);setHistoryLoading(false);});return;}
 const ownerUid=currentUser.uid,dbRef=localDB;
 historyUnsubscribe=onSnapshot(collection(db,"users",ownerUid,"bills"),async snap=>{
  if(!currentUser||currentUser.uid!==ownerUid||localDB!==dbRef)return;
  const pending=await dbRef.getAll("pending");
  if(!currentUser||currentUser.uid!==ownerUid||localDB!==dbRef)return;
  const billJobs=pending.filter(x=>x.collectionName==="bills"),pendingIds=new Set(billJobs.map(x=>x.targetId||x.id)),pendingDeletes=new Set(billJobs.filter(x=>x.type==="delete").map(x=>x.targetId||x.id));
  const cloud=snap.docs.map(d=>d.data()).filter(x=>x&&x.id&&!pendingDeletes.has(x.id));
  for(const item of cloud)if(!pendingIds.has(item.id))await dbRef.put("bills",item);
  if(!currentUser||currentUser.uid!==ownerUid||localDB!==dbRef)return;
  const local=asArray(await dbRef.getAll("bills")).filter(x=>x&&typeof x==="object"),merged=new Map(cloud.filter(x=>x&&x.id).map(x=>[x.id,x]));
  if(!currentUser||currentUser.uid!==ownerUid||localDB!==dbRef)return;
  for(const item of local)if(pendingIds.has(item.id))merged.set(item.id,item);
  savedBills=[...merged.values()].sort((a,b)=>(b.createdAtMillis||0)-(a.createdAtMillis||0));renderBillingHistory();setHistoryLoading(false);
 },err=>{console.warn("Billing history:",err);localDB.getAll("bills").then(items=>{savedBills=items.sort((a,b)=>(b.createdAtMillis||0)-(a.createdAtMillis||0));renderBillingHistory();$("billingHistoryList").insertAdjacentHTML("afterbegin",'<p class="message">Cloud unavailable — showing locally saved bills.</p>');setHistoryLoading(false);});});
}
function billDate(item){const raw=Number(item?.createdAtMillis)||Date.parse(item?.createdAt)||Date.now();const d=new Date(raw);return Number.isNaN(d.getTime())?new Date():d;}
function localDateKey(date){return [date.getFullYear(),String(date.getMonth()+1).padStart(2,"0"),String(date.getDate()).padStart(2,"0")].join("-");}
function dateHeading(date){const today=new Date(),yesterday=new Date();yesterday.setDate(today.getDate()-1);if(localDateKey(date)===localDateKey(today))return "Today";if(localDateKey(date)===localDateKey(yesterday))return "Yesterday";return date.toLocaleDateString(undefined,{weekday:"long",day:"numeric",month:"long",year:"numeric"});}
function renderBillingHistory(){
 savedBills=asArray(savedBills).filter(item=>item&&typeof item==="object");const root=$("billingHistoryList");if(!root)return;if(historyObserver){historyObserver.disconnect();historyObserver=null;}
 const q=($("historySearch")?.value||"").trim().toLowerCase();
 const rows=asArray(savedBills).filter(x=>x&&typeof x==="object"&&((x.receiptNumber||"").toLowerCase().includes(q)||(x.patientName||"").toLowerCase().includes(q))).sort((a,b)=>billDate(b)-billDate(a));
 const visibleRows=rows.slice(0,historyVisibleCount);
 root.innerHTML="";
 if(syncNotice){const notice=document.createElement("p");notice.className="sync-status-note";notice.textContent=syncNotice;const dismiss=document.createElement("button");dismiss.type="button";dismiss.className="tiny";dismiss.textContent="Dismiss";dismiss.onclick=()=>{syncNotice="";notice.remove();};notice.append(" ",dismiss);root.append(notice);}
 if(!rows.length){root.innerHTML+='<p class="muted">No saved bills found.</p>';return;}
 const groups=new Map();visibleRows.forEach(item=>{const date=billDate(item),key=localDateKey(date);if(!groups.has(key))groups.set(key,{date,items:[]});groups.get(key).items.push(item);});
 for(const group of groups.values()){
  const section=document.createElement("section");section.className="history-date-group";
  const heading=document.createElement("div");heading.className="history-date-heading";const label=document.createElement("b");label.textContent=dateHeading(group.date);const count=document.createElement("small");count.textContent=group.items.length+" "+(group.items.length===1?"bill":"bills");heading.append(label,count);section.append(heading);
  group.items.forEach(item=>{
   const row=document.createElement("div");row.className="history-row";row.tabIndex=0;row.setAttribute("role","button");row.setAttribute("aria-label","Open receipt "+(item.receiptNumber||""));const info=document.createElement("span");info.className="history-info";info.innerHTML="<b></b><small></small>";info.querySelector("b").textContent=item.patientName||"Patient";info.querySelector("small").textContent=(item.transactionType==="refund"?"Refund / Exchange · ":"")+(item.receiptNumber||"Receipt")+" · "+billDate(item).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
   const total=document.createElement("strong");total.textContent=item.transactionType==="refund"?(item.cashDirection==="refund"?"− ":item.cashDirection==="collect"?"+ ":"")+wholeMoney(item.cashAmount):wholeMoney(item.finalTotal);if(item.transactionType==="refund")total.classList.add(item.cashDirection==="refund"?"history-refund-out":"history-refund-in");row.append(info,total);row.onclick=()=>{notify("Opening receipt "+item.receiptNumber,"info",2200);showReceipt(item);};row.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();notify("Opening receipt "+item.receiptNumber,"info",2200);showReceipt(item);}};
   if(billEditAllowed(item)){const actions=document.createElement("span");actions.className="history-actions";if(item.transactionType!=="refund"){const edit=document.createElement("button");edit.type="button";edit.className="tiny bill-edit-action";edit.textContent="Edit";edit.onclick=e=>{e.stopPropagation();beginBillEdit(item);};actions.append(edit);}const del=document.createElement("button");del.type="button";del.className="tiny danger bill-delete-action";del.innerHTML='<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14M9 6V4h6v2m3 0-1 14H7L6 6m4 4v7m4-7v7"/></svg>';del.title="Delete bill";del.setAttribute("aria-label","Delete bill "+item.receiptNumber);del.onclick=e=>{e.stopPropagation();deleteSavedBill(item);};actions.append(del);row.append(actions);}section.append(row);
  });root.append(section);
 }
 if(visibleRows.length<rows.length){const sentinel=document.createElement("div");sentinel.className="history-load-sentinel";sentinel.setAttribute("aria-live","polite");sentinel.textContent="Loading more transactions…";root.append(sentinel);if("IntersectionObserver" in window){historyObserver=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){historyObserver.disconnect();historyObserver=null;historyVisibleCount=Math.min(historyVisibleCount+9,rows.length);renderBillingHistory();}},{root:null,rootMargin:"240px 0px",threshold:0});historyObserver.observe(sentinel);}}
}
// Client-side one-hour convenience window. Firestore Rules do not impose an expiry.
function billEditExpiry(item){const created=Number(item?.createdAtMillis)||Date.parse(item?.createdAt)||0;return created>0?created+3600000:0;}
function billEditAllowed(item){const expiry=billEditExpiry(item);return expiry>0&&Date.now()<expiry;}
function beginBillEdit(item){
 if(!billEditAllowed(item)){alert("This bill is locked after 1 hour.");renderBillingHistory();return;}
 editingBillId=item.id;editingBillCreatedAt=Number(item.createdAtMillis)||Date.now();
 $("patientName").value=item.patientName||"";$("tokenNumber").value=item.tokenNumber||"";$("discount").value=Number(item.discount)||0;setDiscountEditor(Number(item.discount)>0);
 bill=asArray(item.items).filter(line=>line&&typeof line==="object").map(line=>({id:line.medicineId||crypto.randomUUID(),kind:line.kind==="custom"?"custom":"medicine",name:line.name,unit:line.unit||(line.kind==="custom"?"Charge":"Piece"),qty:Number(line.quantity)||1,price:Number(line.originalUnitPrice??line.unitPrice)||0,isFixedCharge:line.kind==="custom"&&line.isFixedCharge===true,roundingAllowed:line.kind!=="custom"&&line.roundingAllowed===true,adjustment:line.kind==="custom"?0:(Number(line.lineAdjustment)||0)}));
 $("saveBill").textContent="Update";$("printBill").textContent="Update & Print";$("billMessage").textContent="";
 $("cancelBillEdit")?.remove();
 renderBill();$("billMessage").textContent="";notify("Bill opened for editing","info",2200);
 openAppModal(document.querySelector(".bill-panel"),"Edit Bill", "Update patient, items or discount.","edit");
}
function cancelBillEdit(){
 editingBillId=null;editingBillCreatedAt=0;bill=[];$("patientName").value="";$("tokenNumber").value="";$("discount").value="0";setDiscountEditor(false);
 $("saveBill").textContent="Save";$("printBill").textContent="Save & Print";$("billMessage").textContent="";
 renderBill();$("cancelBillEdit")?.remove();closeAppModal();
}
async function deleteSavedBill(item){
 if(!billEditAllowed(item)){alert("This bill is locked after 1 hour.");return;}
 if(!await confirmAction("Delete bill","Delete receipt "+item.receiptNumber+"? This cannot be undone.","Delete bill"))return;
 notify("Deleting receipt "+item.receiptNumber,"info",2200);
 try{await localDB.delete("bills",item.id);await queueChange(item.id,"delete",item,"bills");savedBills=savedBills.filter(x=>x.id!==item.id);renderBillingHistory();notify("Bill deleted","success");if(navigator.onLine)flushQueue().catch(console.warn);}
 catch(err){notify("Delete failed: "+err.message,"error",5200);}
}
function printReceipt(){
 const root=$("receiptDetail");if(!root)return;
 notify("Preparing receipt for printing","info",2400);
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
 if(item.transactionType==="refund"){
  const brand=document.createElement("div");brand.className="receipt-brand";const brandName=document.createElement("b");brandName.textContent="FRIENDS HOSPITAL PHARMACY";const brandSub=document.createElement("small");brandSub.textContent="REFUND / EXCHANGE RECEIPT";brand.append(brandName,brandSub);root.append(brand);
  const title=document.createElement("h3");title.textContent=item.receiptNumber;root.append(title);
  const meta=document.createElement("div");meta.className="receipt-meta";const patient=document.createElement("strong");patient.className="receipt-patient";patient.textContent="PATIENT: "+(item.patientName||"—");const details=document.createElement("span");details.textContent=(item.tokenNumber?"Token: "+item.tokenNumber+" · ":"")+new Date(item.createdAtMillis||Date.now()).toLocaleString();meta.append(patient,details);root.append(meta);
  const addSection=(heading,lines)=>{
   if(!asArray(lines).length)return;
   const label=document.createElement("h4");label.className="refund-receipt-heading";label.textContent=heading;root.append(label);
   const table=document.createElement("div");table.className="receipt-lines";const head=document.createElement("div");head.className="receipt-line receipt-head";["#","Medicine","Qty","Amount"].forEach(value=>{const cell=document.createElement("span");cell.textContent=value;head.append(cell);});table.append(head);
   asArray(lines).forEach((line,index)=>{const row=document.createElement("div");row.className="receipt-line";const serial=document.createElement("span");serial.className="receipt-serial";serial.textContent=String(index+1);const name=document.createElement("span");name.className="receipt-medicine";name.textContent=line.name;const qty=document.createElement("span");qty.className="receipt-qty";qty.textContent=String(line.quantity)+" "+(line.unit||"");const amount=document.createElement("b");amount.className="receipt-amount";amount.textContent=Math.round(Number(line.lineTotal)||0).toLocaleString("en-PK");row.append(serial,name,qty,amount);table.append(row);});root.append(table);
  };
  addSection("Returned medicines",item.refundItems);addSection("New medicines",item.newItems);
  const summary=document.createElement("div");summary.className="receipt-summary";
  const addTotal=(label,value,kind="")=>{const row=document.createElement("div");row.className="receipt-summary-row"+(kind?" "+kind:"");const l=document.createElement("span");l.textContent=label;const v=document.createElement("b");v.textContent=Math.round(Number(value)||0).toLocaleString("en-PK");row.append(l,v);summary.append(row);};
  addTotal("Returned medicines",item.returnedSubtotal);addTotal("Deduction (25%)",item.deductionAmount,"discount");addTotal("Refund credit",item.refundCredit);addTotal("New medicines",item.newSubtotal);
  addTotal(item.cashDirection==="collect"?"Cash to collect":item.cashDirection==="refund"?"Cash refunded":"Cash difference",item.cashAmount,"final");
  root.append(summary);const footer=document.createElement("p");footer.className="receipt-thanks";footer.textContent=item.cashDirection==="collect"?"Please collect the balance.":item.cashDirection==="refund"?"Refund paid to patient.":"Transaction settled.";root.append(footer);
  const actions=document.createElement("div");actions.className="receipt-detail-actions print-hide";
  if(billEditAllowed(item)){const del=document.createElement("button");del.type="button";del.className="danger-button";del.textContent="Delete transaction";del.onclick=async()=>{closeAppModal();await deleteSavedBill(item);};actions.append(del);}
  const print=document.createElement("button");print.type="button";print.className="secondary print-hide";print.textContent="Print receipt";print.onclick=printReceipt;actions.append(print);root.append(actions);
  openAppModal(root,"Refund / Exchange "+item.receiptNumber,"Transaction details and receipt.","view");return;
 }
 const brand=document.createElement("div");brand.className="receipt-brand";
 const brandName=document.createElement("b");brandName.textContent="FRIENDS HOSPITAL PHARMACY";
 const brandSub=document.createElement("small");brandSub.textContent="PHARMACY BILL";
 brand.append(brandName,brandSub);root.append(brand);
 const title=document.createElement("h3");title.textContent=item.receiptNumber;root.append(title);
 const meta=document.createElement("div");meta.className="receipt-meta";
 const patient=document.createElement("strong");patient.className="receipt-patient";patient.textContent="PATIENT: "+(item.patientName||"—");
 const details=document.createElement("span");details.textContent=(item.tokenNumber?"Token: "+item.tokenNumber+" · ":"")+new Date(item.createdAtMillis||Date.now()).toLocaleString();
 meta.append(patient,details);root.append(meta);
 const table=document.createElement("div");table.className="receipt-lines";
 const head=document.createElement("div");head.className="receipt-line receipt-head";
 ["#","Item","Qty","Amount"].forEach(label=>{const cell=document.createElement("span");cell.textContent=label;head.append(cell);});
 table.append(head);
 asArray(item.items).filter(line=>line&&typeof line==="object").forEach((line,index)=>{
  const row=document.createElement("div");row.className="receipt-line";
  const serial=document.createElement("span");serial.className="receipt-serial";serial.textContent=String(index+1);
  const number=document.createElement("span");number.className="receipt-number";number.textContent=String(line.itemNumber||table.children.length)+".";
  const name=document.createElement("span");name.className="receipt-medicine";name.textContent=line.name;
  const qty=document.createElement("span");qty.className="receipt-qty";qty.textContent=line.kind==="custom"&&line.isFixedCharge===true?"—":String(line.quantity)+" "+(line.unit||"");
  const amount=document.createElement("b");amount.className="receipt-amount";amount.textContent=Math.round(Number(line.lineTotal)||0).toLocaleString("en-PK");
  row.append(serial,name,qty,amount);table.append(row);
 });root.append(table);
 const summary=document.createElement("div");summary.className="receipt-summary";
 const addTotal=(label,value,kind="")=>{const row=document.createElement("div");row.className="receipt-summary-row"+(kind?" "+kind:"");const l=document.createElement("span");l.textContent=label;const v=document.createElement("b");v.textContent=Math.round(Number(value)||0).toLocaleString("en-PK");row.append(l,v);summary.append(row);};
 if(Number(item.discount)>0){addTotal("Subtotal",item.subtotal);addTotal("Discount",item.discount,"discount");addTotal("TOTAL",item.finalTotal,"final");}
 else addTotal("TOTAL",item.finalTotal,"final");
 root.append(summary);
 const footer=document.createElement("p");footer.className="receipt-thanks";footer.textContent="Thank you. Get well soon!";root.append(footer);
 const receiptActions=document.createElement("div");receiptActions.className="receipt-detail-actions print-hide";
 if(billEditAllowed(item)){const edit=document.createElement("button");edit.type="button";edit.className="primary";edit.textContent="Edit bill";edit.onclick=()=>{closeAppModal();beginBillEdit(item);};const del=document.createElement("button");del.type="button";del.className="danger-button";del.textContent="Delete bill";del.onclick=async()=>{closeAppModal();await deleteSavedBill(item);};receiptActions.append(edit,del);}
 const print=document.createElement("button");print.type="button";print.className="secondary print-hide";print.textContent="Print receipt";print.onclick=printReceipt;receiptActions.append(print);root.append(receiptActions);
 openAppModal(root,"Bill "+item.receiptNumber,"Receipt details, edit and print options.","view");
}
$("historySearch").oninput=()=>{historyVisibleCount=9;renderBillingHistory();};
function setStatementDates(){const now=new Date(),mode=$("statementPeriod").value;let from=new Date(now),to=new Date(now);if(mode==="week"){const day=(now.getDay()+6)%7;from.setDate(now.getDate()-day);from.setHours(0,0,0,0);to.setHours(23,59,59,999);}else if(mode==="month"){from=new Date(now.getFullYear(),now.getMonth(),1);to=new Date(now.getFullYear(),now.getMonth()+1,0,23,59,59,999);}else if(mode==="lastMonth"){from=new Date(now.getFullYear(),now.getMonth()-1,1);to=new Date(now.getFullYear(),now.getMonth(),0,23,59,59,999);}else if(mode==="today"){from=new Date(now);from.setHours(0,0,0,0);to=new Date(now);to.setHours(23,59,59,999);} $("statementFrom").value=localDateKey(from);$("statementTo").value=localDateKey(to);$("statementCustomDates").classList.toggle("hidden",mode!=="custom");}
function openStatement(){show("statementModal",true);$("statementPreview").innerHTML='<p class="muted">Choose a period and select Generate statement.</p>';setStatementDates();}
function closeStatement(){show("statementModal",false);$("statementPrintArea").innerHTML="";}
function generateStatement(){
 const fv=$("statementFrom").value,tv=$("statementTo").value;if(!fv||!tv||fv>tv){$("statementPreview").innerHTML='<p class="message">Please select a valid date range.</p>';return;}
 const from=new Date(fv+"T00:00:00"),to=new Date(tv+"T23:59:59.999"),rows=savedBills.filter(x=>billDate(x)>=from&&billDate(x)<=to).sort((a,b)=>billDate(a)-billDate(b));
 const total=rows.reduce((s,x)=>s+(Number(x.finalTotal)||0),0),discount=rows.reduce((s,x)=>s+(Number(x.discount)||0),0),area=$("statementPrintArea");area.innerHTML="";
 const heading=document.createElement("div");heading.className="statement-print-heading";const brand=document.createElement("b"),sub=document.createElement("span"),period=document.createElement("small");brand.textContent="FRIENDS HOSPITAL PHARMACY";sub.textContent="BILLING STATEMENT";period.textContent=from.toLocaleDateString()+" — "+to.toLocaleDateString();heading.append(brand,sub,period);area.append(heading);
 const summary=document.createElement("div");summary.className="statement-summary";[["Total bills",String(rows.length)],["Total discount",wholeMoney(discount)],["Net sales",wholeMoney(total)]].forEach(([k,v])=>{const cell=document.createElement("div"),l=document.createElement("small"),b=document.createElement("b");l.textContent=k;b.textContent=v;cell.append(l,b);summary.append(cell);});area.append(summary);
 const table=document.createElement("table");table.className="statement-table";const thead=document.createElement("thead"),trh=document.createElement("tr");["Date & time","Receipt","Patient","Amount"].forEach(t=>{const th=document.createElement("th");th.textContent=t;trh.append(th);});thead.append(trh);table.append(thead);const tbody=document.createElement("tbody");
 rows.forEach(item=>{const tr=document.createElement("tr"),d=billDate(item);[d.toLocaleString(),item.receiptNumber||"—",item.patientName||"—",wholeMoney(item.finalTotal)].forEach(v=>{const td=document.createElement("td");td.textContent=v;if(tr.children.length===3)td.className="statement-amount";tr.append(td);});tbody.append(tr);});
 if(!rows.length){const tr=document.createElement("tr"),td=document.createElement("td");td.colSpan=4;td.textContent="No bills found in this date range.";tr.append(td);tbody.append(tr);}table.append(tbody);area.append(table);
 $("statementPreview").innerHTML="";const note=document.createElement("p");note.className="statement-result-note";note.textContent=rows.length+" bills · Net sales "+wholeMoney(total);$("statementPreview").append(note);
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
  const first=document.createElement("input");first.type="password";first.autocomplete=setup?"new-password":"current-password";first.placeholder=setup?"Create password (6+ characters)":"Edit Mode password";
  const second=document.createElement("input");second.type="password";second.autocomplete="new-password";second.placeholder="Confirm password";second.classList.toggle("hidden",!setup);
  const error=document.createElement("p");error.className="message";
  const actions=document.createElement("div");actions.className="modal-actions";
  const cancel=document.createElement("button"),submit=document.createElement("button");cancel.type=submit.type="button";cancel.className="secondary";submit.className="primary";cancel.textContent="Cancel";submit.textContent=setup?"Set password":"Unlock";
  cancel.onclick=()=>{closeAppModal();resolve(false);};
  submit.onclick=async()=>{error.textContent="";if(first.value.length<6){error.textContent="Use at least 6 characters.";first.focus();return;}if(setup&&first.value!==second.value){error.textContent="Passwords do not match.";second.focus();return;}submit.disabled=true;try{if(setup)await saveEditModePassword(first.value);else{const record=await localDB.get("meta","medicineEditPassword");if(!record||!await verifyEditModePassword(first.value,record)){error.textContent="Incorrect password.";submit.disabled=false;first.focus();return;}}closeAppModal();resolve(true);}catch(err){error.textContent=err?.message||"Could not save password.";submit.disabled=false;}};
  actions.append(cancel,submit);box.append(first,second,error,actions);
  if(!setup){
   const forgot=document.createElement("button");forgot.type="button";forgot.className="text-button edit-mode-forgot";forgot.textContent="Forgot password?";
   forgot.onclick=async()=>{
    const recovery=document.createElement("div");recovery.className="edit-mode-password recovery-flow";
    const statusCard=document.createElement("div");statusCard.className="recovery-status-card";
    const icon=document.createElement("span");icon.className="recovery-status-icon";icon.textContent="✓";
    const title=document.createElement("b");title.textContent="Request a recovery code";
    const detail=document.createElement("p");detail.textContent="Submit one request. Our admin will verify it and send your 12-digit recovery code on WhatsApp within 24–48 hours.";
    statusCard.append(icon,title,detail);
    const status=document.createElement("p");status.className="recovery-inline-status";status.setAttribute("role","status");
    const request=document.createElement("button");request.type="button";request.className="primary full";request.textContent="Send recovery request";
    const contact=document.createElement("a");contact.href="https://wa.me/"+SUPPORT_WHATSAPP+"?text="+encodeURIComponent("I need help with Edit Mode password recovery. Registered email: "+(currentUser?.email||""));contact.target="_blank";contact.rel="noopener noreferrer";contact.className="recovery-contact";
    contact.innerHTML='<span>Contact support</span><b>+92 348 631 4013</b>';
    const code=document.createElement("input");code.type="text";code.inputMode="numeric";code.autocomplete="one-time-code";code.placeholder="Enter your 12-digit recovery code";code.maxLength=12;code.inputMode="numeric";
    const verify=document.createElement("button");verify.type="button";verify.className="primary full";verify.textContent="Verify recovery code";
    const newPass=document.createElement("input");newPass.type="password";newPass.autocomplete="new-password";newPass.placeholder="New password (6+ characters)";
    const confirm=document.createElement("input");confirm.type="password";confirm.autocomplete="new-password";confirm.placeholder="Confirm new password";
    const save=document.createElement("button");save.type="button";save.className="primary full";save.textContent="Save new password";
    const fields=document.createElement("div");fields.className="hidden recovery-password-fields";fields.append(newPass,confirm,save);let verified=null;
    const showPending=()=>{
      statusCard.classList.add("is-success");icon.textContent="✓";title.textContent="Request successfully submitted";
      detail.textContent="Your request is safely received. Your recovery code will be sent to your registered WhatsApp number within 24–48 hours. Please don't submit another request.";
      request.classList.add("hidden");status.textContent="Status: Pending admin verification.";
    };
    const loadRecoveryState=async()=>{
      status.textContent="Checking request status…";request.disabled=true;
      try{
       const [pending,cooldown]=await Promise.all([getDoc(doc(db,"editModeRecoveryRequests",currentUser.uid)),getDoc(doc(db,"editModeRecoveryCooldown",currentUser.uid))]);
       if(pending.exists()){showPending();return;}
       if(cooldown.exists()){
        const until=cooldown.data().retryAfter?.toMillis?.()||0,remaining=until-Date.now();
        if(remaining>0){statusCard.classList.add("is-success");icon.textContent="✓";title.textContent="Recovery recently completed";detail.textContent="For security, you can submit another request after the waiting period.";request.classList.add("hidden");const when=new Date(until).toLocaleString();status.textContent="You can request again after: "+when;return;}
       }
       status.textContent="";request.disabled=false;
      }catch(err){status.textContent="Unable to check request status. Please check your internet connection and try again.";request.disabled=false;}
    };
    request.onclick=async()=>{
      if(!currentUser?.uid||!currentUser.email)return;
      request.disabled=true;request.textContent="Sending request…";status.textContent="";
      try{
       const pending=await getDoc(doc(db,"editModeRecoveryRequests",currentUser.uid));
       if(pending.exists()){showPending();return;}
       const cooldown=await getDoc(doc(db,"editModeRecoveryCooldown",currentUser.uid));
       const until=cooldown.data()?.retryAfter?.toMillis?.()||0;
       if(until>Date.now()){await loadRecoveryState();return;}
       await setDoc(doc(db,"editModeRecoveryRequests",currentUser.uid),{email:currentUser.email,requestedAt:serverTimestamp()});
       showPending();
      }catch(err){status.textContent=err?.code==="permission-denied"?"Request blocked by Firestore permissions. Please contact support.":"Request could not be sent. Check your connection and try again.";request.disabled=false;request.textContent="Send recovery request";}
    };
    verify.onclick=async()=>{
      status.textContent="";verify.disabled=true;
      try{
       const enteredCode=code.value.trim();if(!/^\d{8,12}$/.test(enteredCode))throw new Error("Enter the recovery code sent by the admin.");const snap=await getDoc(doc(db,"editModeRecoveryApprovals",currentUser.uid));if(!snap.exists())throw new Error("Your request is still being reviewed. The code will be sent after approval.");
       const data=snap.data(),expiry=data.expiresAt;
       if(data.approved!==true||typeof data.codeHash!=="string"||!expiry?.toMillis||expiry.toMillis()<=Date.now())throw new Error("Code is invalid or expired. Contact support.");
       const parts=data.codeHash.split(":");if(parts.length!==2)throw new Error("Invalid approval.");
       const salt=Uint8Array.from(parts[0].match(/.{1,2}/g)||[],x=>parseInt(x,16));
       const material=await crypto.subtle.importKey("raw",new TextEncoder().encode(enteredCode),"PBKDF2",false,["deriveBits"]);
       const derived=await crypto.subtle.deriveBits({name:"PBKDF2",salt,iterations:250000,hash:"SHA-256"},material,256);
       const digest=Array.from(new Uint8Array(derived),x=>x.toString(16).padStart(2,"0")).join("");
       if(digest!==parts[1])throw new Error("Incorrect recovery code. Please check it.");
       verified=data;code.disabled=true;verify.classList.add("hidden");fields.classList.remove("hidden");status.textContent="✓ Code verified. Now create your new password.";
      }catch(err){status.textContent=err?.message||"Verification failed.";verify.disabled=false;}
    };
    save.onclick=async()=>{
      status.textContent="";
      if(newPass.value.length<6||newPass.value!==confirm.value){status.textContent="Enter matching passwords (6+ characters).";return;}
      save.disabled=true;
      try{
       const latest=await getDoc(doc(db,"editModeRecoveryApprovals",currentUser.uid));
       if(!verified||!latest.exists()||latest.data().codeHash!==verified.codeHash)throw new Error("Approval changed. Verify the code again.");
       await saveEditModePassword(newPass.value);await deleteDoc(doc(db,"editModeRecoveryApprovals",currentUser.uid));
       closeAppModal();resolve(true);
      }catch(err){status.textContent=err?.message||"Could not save password.";save.disabled=false;}
    };
    const back=document.createElement("button");back.type="button";back.className="text-button";back.textContent="← Back";back.onclick=()=>openAppModal(box,"Unlock Edit Mode","","edit-password");
    recovery.append(statusCard,status,request,contact,code,verify,fields,back);
    openAppModal(recovery,"Recover Edit Mode password","","recovery");loadRecoveryState();
   };box.append(forgot);
  }
  openAppModal(box,setup?"Set Edit Mode Password":"Unlock Edit Mode","","edit-password");first.focus();
 });
}
async function enableMedicineEditMode(){
 if(!currentUser||!localDB)return;
 const record=await localDB.get("meta","medicineEditPassword");
 const ok=await editModePasswordDialog(!record);
 if(!ok){$("medicineEditMode").checked=false;medicineModeEnabled=false;await localDB.put("meta",false,"medicineModeEnabled");renderMedicines($("medicineSearch").value);renderBillSearch($("billSearch")?.value||"");return;}
 medicineModeEnabled=true;$("medicineEditMode").checked=true;await localDB.put("meta",true,"medicineModeEnabled");renderMedicines($("medicineSearch").value);renderBillSearch($("billSearch")?.value||"");
}
$("medicineEditMode").onchange=async()=>{
 if($("medicineEditMode").checked){$("medicineEditMode").checked=false;await enableMedicineEditMode();return;}
 medicineModeEnabled=false;await localDB.put("meta",false,"medicineModeEnabled");if(modalKind==="medicine")closeMedicineModal();renderMedicines($("medicineSearch").value);renderBillSearch($("billSearch")?.value||"");
};
function showNewPackingFields(){const mode=$("medicineImageMode"),fields=$("newPackingFields"),hint=$("packingModeHint"),replaceTab=$("packingReplaceTab"),newTab=$("packingNewTab");if(mode&&fields){const isNew=mode.value==="new";fields.classList.toggle("hidden",!isNew);if(hint)hint.textContent=isNew?"A separate packing will be saved with its own name, unit, price and image. Your current packing will remain unchanged.":"Current packing image will be updated. Its name, unit and price will stay unchanged.";if(replaceTab){replaceTab.classList.toggle("active",!isNew);replaceTab.setAttribute("aria-pressed",String(!isNew));}if(newTab){newTab.classList.toggle("active",isNew);newTab.setAttribute("aria-pressed",String(isNew));}}}
$("medicineImageMode").onchange=showNewPackingFields;
$("packingReplaceTab").onclick=()=>{$("medicineImageMode").value="replace";showNewPackingFields();};
$("packingNewTab").onclick=()=>{$("medicineImageMode").value="new";showNewPackingFields();};
$("changeMedicineImage").onclick=()=>{if(!medicineModeEnabled)return;$("medicineImage").click();};
$("medicineImage").onchange=()=>{const file=$("medicineImage").files?.[0];if(!file){const existing=medicines.find(m=>m.id===$("medicineId").value);if(existing?.image)showMedicineImagePreview(existing.image);else resetMedicineImagePreview();return;}if(!file.type.startsWith("image/")){alert("Please select a valid image.");$("medicineImage").value="";return;}if(file.size>8*1024*1024){alert("Image must be 8 MB or smaller.");$("medicineImage").value="";return;}const reader=new FileReader();reader.onload=()=>{medicineImageRotation=0;medicineImageCrop=false;showMedicineImagePreview(reader.result);openMedicineImageEditor();};reader.readAsDataURL(file);};
$("saveName").onclick=async()=>{if(!currentUser)return;try{await updateProfile(currentUser,{displayName:$("displayName").value.trim()});$("userLabel").textContent=$("displayName").value.trim()||currentUser.email;notify("Display name updated","success");}catch(err){notify("Could not update display name: "+err.message,"error",5200);}};
function backupImageCount(items){let count=0;for(const m of asArray(items)){if(typeof m?.image==="string"&&m.image)count++;for(const p of asArray(m?.packagings))if(typeof p?.image==="string"&&p.image)count++;}return count;}
async function portableBackupImage(value){
 if(typeof value!=="string"||!value||value.startsWith("data:")||!value.includes("firebasestorage.googleapis.com"))return value||"";
 const response=await fetch(value);if(!response.ok)throw Error("A Firebase image could not be included in the backup (HTTP "+response.status+"). Keep the old backup and retry.");
 const blob=await response.blob();if(blob.size>8*1024*1024)throw Error("An image is larger than the 8 MB upload limit.");
 const bytes=new Uint8Array(await blob.arrayBuffer());let binary="";
 for(let offset=0;offset<bytes.length;offset+=0x8000)binary+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000));
 return "data:"+(blob.type||"image/png")+";base64,"+btoa(binary);
}
async function makePortableBackupMedicines(items){
 const result=[];
 for(const source of items){
  const medicine={...source,image:await portableBackupImage(source.image)};
  if(Array.isArray(source.packagings)){medicine.packagings=[];for(const pack of source.packagings)medicine.packagings.push({...pack,image:await portableBackupImage(pack?.image)});}
  result.push(medicine);
 }
 return result;
}
function backupChoice(title,description,choices){
 return new Promise(resolve=>{
  const wrap=document.createElement("div");wrap.className="backup-choice-dialog";
  const intro=document.createElement("p");intro.className="muted small-text";intro.textContent=description;wrap.append(intro);
  const actions=document.createElement("div");actions.className="modal-actions";
  for(const choice of choices){const btn=document.createElement("button");btn.type="button";btn.className=choice.primary?"primary":"secondary";btn.textContent=choice.label;btn.onclick=()=>{closeAppModal();resolve(choice.value);};actions.append(btn);}
  const cancel=document.createElement("button");cancel.type="button";cancel.className="secondary";cancel.textContent="Cancel";cancel.onclick=()=>{closeAppModal();resolve(null);};
  wrap.append(actions,cancel);openAppModal(wrap,title,"Choose what to "+(title.toLowerCase().includes("export")?"export":"import"),"content");
 });
}
async function exportBackup(){
 if(!currentUser||!localDB)throw Error("Please sign in before exporting.");
 const mode=await backupChoice("Export backup","Choose complete backup, all medicines only, or select individual medicines.",[
  {label:"Complete data",value:"all",primary:true},{label:"All medicines only",value:"medicines"},{label:"Select medicines",value:"selected"}
 ]);
 if(!mode)return;
 const allMedicines=(await localDB.getAll("medicines")).filter(x=>x&&x.id&&x.name);
 const allBills=(await localDB.getAll("bills")).filter(x=>x&&x.id&&x.receiptNumber);
 let chosen=allMedicines;
 if(mode==="selected"){
  const wrap=document.createElement("div");wrap.className="backup-medicine-picker";
  const search=document.createElement("input");search.type="search";search.placeholder="Search medicines";search.className="backup-picker-search";
  const list=document.createElement("div");list.className="backup-picker-list";
  const checks=[];
  for(const medicine of allMedicines){const label=document.createElement("label");label.className="backup-picker-row";const input=document.createElement("input");input.type="checkbox";input.value=medicine.id;input.checked=true;const name=document.createElement("span");name.textContent=medicine.name;label.append(input,name);list.append(label);checks.push({label,input,name});}
  search.oninput=()=>{const q=search.value.trim().toLowerCase();for(const item of checks)item.label.hidden=!item.name.textContent.toLowerCase().includes(q);};
  const top=document.createElement("div");top.className="backup-picker-actions";
  const selectAll=document.createElement("button");selectAll.type="button";selectAll.className="secondary";selectAll.textContent="Select all";selectAll.onclick=()=>checks.forEach(x=>x.input.checked=true);
  const selectNone=document.createElement("button");selectNone.type="button";selectNone.className="secondary";selectNone.textContent="Clear";selectNone.onclick=()=>checks.forEach(x=>x.input.checked=false);
  top.append(selectAll,selectNone);wrap.append(search,top,list);
  const actions=document.createElement("div");actions.className="modal-actions";
  const cancel=document.createElement("button");cancel.type="button";cancel.className="secondary";cancel.textContent="Cancel";
  const save=document.createElement("button");save.type="button";save.className="primary";save.textContent="Export selected";
  const result=await new Promise(resolve=>{cancel.onclick=()=>{closeAppModal();resolve(null);};save.onclick=()=>{const ids=new Set(checks.filter(x=>x.input.checked).map(x=>x.input.value));closeAppModal();resolve(allMedicines.filter(x=>ids.has(x.id)));};actions.append(cancel,save);wrap.append(actions);openAppModal(wrap,"Select medicines","Choose the medicines to include in this file.","content");});
  if(!result)return;chosen=result;
 }
 const portable=await makePortableBackupMedicines(chosen);
 const includeBills=mode==="all";
 const backup={format:"friends-pharmacy-backup",version:4,backupType:includeBills?"complete":mode==="selected"?"selected-medicines":"medicines-only",exportedAt:new Date().toISOString(),ownerUid:currentUser.uid,manifest:{medicineCount:portable.length,billCount:includeBills?allBills.length:0,imageCount:backupImageCount(portable)},medicines:portable,bills:includeBills?allBills:[]};
 const verified=JSON.parse(JSON.stringify(backup));
 if(verified.medicines.length!==backup.manifest.medicineCount||verified.bills.length!==backup.manifest.billCount||backupImageCount(verified.medicines)!==backup.manifest.imageCount)throw Error("Backup verification failed.");
 const blob=new Blob([JSON.stringify(verified,null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");
 a.href=url;a.download="friends-pharmacy-"+backup.backupType+"-"+new Date().toISOString().slice(0,10)+".json";a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);
 const line="Export complete: "+portable.length+" medicines, "+backup.manifest.imageCount+" images, "+backup.manifest.billCount+" bills.";
 const node=$("importStatus");if(node){node.textContent=line;node.className="message success";}notify(line,"success",7000);
}
$("exportData").onclick=async()=>{const button=$("exportData");button.disabled=true;try{await exportBackup();}catch(err){console.error("Backup export failed:",err);const line="Export failed: "+(err?.message||"Unknown error");const node=$("importStatus");if(node){node.textContent=line;node.className="message error";}notify(line,"error",10000);}finally{button.disabled=false;}};


let installPrompt=null;function updateInstallButton(){const installed=window.matchMedia("(display-mode: standalone)").matches||window.navigator.standalone===true;show("installAppWrap",!!installPrompt&&!installed);}window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();installPrompt=e;updateInstallButton();});window.addEventListener("appinstalled",()=>{installPrompt=null;updateInstallButton();});$("installAppBtn").onclick=async()=>{if(!installPrompt)return;installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;updateInstallButton();};window.matchMedia("(display-mode: standalone)").addEventListener?.("change",updateInstallButton);if("serviceWorker" in navigator)window.addEventListener("load",()=>navigator.serviceWorker.register("./service-worker.js",{updateViaCache:"none"}).catch(err=>console.warn("Service worker:",err)));updateInstallButton();
$("importData").onchange=async e=>{
 const file=e.target.files?.[0];if(!file)return;
 const button=$("importData");button.disabled=true;
 const statusNode=$("importStatus");
 const showImportStatus=(line,type="success")=>{if(statusNode){statusNode.textContent=line;statusNode.className="message "+type;}notify(line,type,10000);};
 try{
  if(!currentUser||!localDB)throw Error("Please sign in before importing.");
  const data=JSON.parse(await file.text());
  if(!data||typeof data!=="object"||!Array.isArray(data.medicines))throw Error("Invalid backup file: medicine list is missing.");
  if(data.bills!==undefined&&!Array.isArray(data.bills))throw Error("Invalid backup file: bills list is invalid.");
  const mode=await backupChoice("Import backup","Choose whether to restore all data in this file or medicines only.",[
   {label:"Complete data",value:"all",primary:true},{label:"Medicines only",value:"medicines"}
  ]);
  if(!mode){showImportStatus("Import cancelled. No data was changed.","info");return;}
  const uid=currentUser.uid,dbRef=localDB;
  let importedMedicines=0,importedBills=0,rejected=0;
  const importedMedicineIds=[],importedBillIds=[];
  for(const raw of data.medicines){
   if(!raw||!raw.id||!raw.name){rejected++;continue;}
   const medicine=normalizeMedicine({...raw,id:String(raw.id),name:String(raw.name).trim()});
   if(!medicine||!medicine.id||!medicine.name){rejected++;continue;}
   await dbRef.put("medicines",medicine);await queueChange(medicine.id,"set",medicine,"medicines");
   importedMedicineIds.push(medicine.id);importedMedicines++;
  }
  if(mode==="all"){
   for(const raw of (data.bills||[])){
    if(!raw||!raw.id||!raw.receiptNumber){rejected++;continue;}
    const restored={...raw,id:String(raw.id),ownerUid:uid,createdAtMillis:Number(raw.createdAtMillis)||Date.now()};
    await dbRef.put("bills",restored);await queueChange(restored.id,"set",restored,"bills");
    importedBillIds.push(restored.id);importedBills++;
   }
   if(importedBills){const allBills=await dbRef.getAll("bills");const maxNumber=allBills.reduce((max,item)=>Math.max(max,Number(String(item.receiptNumber||"").replace(/^B-/,""))||0),0);await dbRef.put("meta",maxNumber,"billCounter");}
  }
  medicines=await dbRef.getAll("medicines");
  if(currentUser?.uid!==uid||localDB!==dbRef)throw Error("Account changed during import.");
  renderMedicines($("medicineSearch")?.value||"");
  if(navigator.onLine)await flushQueue();
  const remaining=await dbRef.getAll("pending");
  const pendingMedicineIds=new Set(remaining.filter(x=>(x.collectionName||"medicines")==="medicines").map(x=>x.targetId||x.id));
  const pendingBillIds=new Set(remaining.filter(x=>x.collectionName==="bills").map(x=>x.targetId||x.id));
  const pendingMedicines=importedMedicineIds.filter(id=>pendingMedicineIds.has(id)).length;
  const pendingBills=importedBillIds.filter(id=>pendingBillIds.has(id)).length;
  const pendingTotal=pendingMedicines+pendingBills;
  const line="Import complete ("+(mode==="all"?"complete data":"medicines only")+"): "+importedMedicines+" medicines, "+backupImageCount(data.medicines)+" images, "+importedBills+" bills imported. "+(pendingTotal?pendingTotal+" record(s) pending Firebase sync.":"All imported records synced or no sync was required.")+(rejected?" "+rejected+" invalid record(s) skipped.":"");
  showImportStatus(line,pendingTotal||rejected?"warning":"success");
  await updatePendingPanel();
 }catch(err){
  console.error("Backup import failed:",err);
  showImportStatus("Import failed: "+(err?.message||"Unknown error")+". Local records already written are preserved; keep this backup file.","error");
 }finally{button.disabled=false;e.target.value="";await updatePendingPanel();}
};

$("addCustomItemBtn").onclick=()=>openCustomItemForm();
