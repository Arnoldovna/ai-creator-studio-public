/* AI Creator Studio v0.1 — browser-only proof of concept.
   No AI API calls. No Instagram API. Only local storage / IndexedDB. */
(() => {
  'use strict';
  const KEY = 'creatorStudio.prototype.v01';
  const MAX_FILE = 60 * 1024 * 1024;
  const allowedTypes = new Set(['image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm','video/quicktime']);
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];
  const esc = (x) => String(x ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
  const csv = (str) => String(str || '').split(/[,;\n]/).map(v=>v.trim()).filter(Boolean).slice(0,25);
  const unique = (xs) => [...new Set(xs.filter(Boolean))];
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
  const defaultState = () => ({ references:[], currentRef:null, style:null, voice:{traits:'',avoid:'',example:''},
    styleForm:{name:'',traits:'',typography:'',motion:'',avoid:''}, brief:{mode:'personal',topic:'',audience:'',goal:'growth',facts:'',length:30},
    concepts:[], selectedConcept:null, script:null, metrics:[], growthInsight:null });
  let state;
  try { state = Object.assign(defaultState(), JSON.parse(localStorage.getItem(KEY) || '{}')); }
  catch { state = defaultState(); }
  let mediaDB;
  let mediaUrls = [];
  let editingRef = null;
  let toastTimer;

  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { toast('Speicherplatz voll: bitte Daten exportieren.'); } };
  const toast = (msg) => { const el=q('#toast'); el.textContent=msg;el.classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.add('hidden'),3700); };
  const downloadJson = (name,obj) => download(name, JSON.stringify(obj,null,2), 'application/json');
  const download = (name,body,mime) => { const b=new Blob([body],{type:mime}),u=URL.createObjectURL(b),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),2000); };
  const today = () => new Date().toISOString().slice(0,10);
  const number = (x) => Number(x || 0).toLocaleString('de-DE');

  function openDb(){ return new Promise((resolve,reject)=>{
    const req=indexedDB.open('creatorStudioMedia.v01',1);
    req.onupgradeneeded=()=>{ if(!req.result.objectStoreNames.contains('media'))req.result.createObjectStore('media'); };
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
  });}
  function dbPut(id,blob){return new Promise((resolve,reject)=>{const tx=mediaDB.transaction('media','readwrite');tx.objectStore('media').put(blob,id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}
  function dbGet(id){return new Promise((resolve,reject)=>{const tx=mediaDB.transaction('media');const rq=tx.objectStore('media').get(id);rq.onsuccess=()=>resolve(rq.result);rq.onerror=()=>reject(rq.error);});}
  function dbDelete(id){return new Promise((resolve,reject)=>{const tx=mediaDB.transaction('media','readwrite');tx.objectStore('media').delete(id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}

  function switchTab(tab){
    qa('.page-panel').forEach(x=>x.classList.toggle('hidden',x.id!==`tab-${tab}`));
    qa('.nav-item').forEach(x=>x.classList.toggle('active',x.dataset.tab===tab));
    q('#breadcrumbCurrent').textContent=({references:'REFERENCE LAB',style:'STYLE & VOICE',content:'CONTENT LAB',growth:'GROWTH LOOP'})[tab]||tab;
    if(tab==='style')renderStyle();if(tab==='content')renderContext();if(tab==='growth')renderGrowth();
  }
  qa('.nav-item').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)));

  function quantColor(r,g,b){const step=32; const v=x=>Math.max(0,Math.min(255,Math.round(x/step)*step)); return [v(r),v(g),v(b)];}
  const toHex=rgb=>'#'+rgb.map(n=>n.toString(16).padStart(2,'0')).join('').toUpperCase();
  async function extractPalette(file){
    if(!file.type.startsWith('image/'))return [];
    let bitmap;
    try { bitmap=await createImageBitmap(file);const canvas=document.createElement('canvas');canvas.width=76;canvas.height=76;
      const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(bitmap,0,0,76,76);
      const p=ctx.getImageData(0,0,76,76).data;const colors=new Map();
      for(let i=0;i<p.length;i+=16){if(p[i+3]<128)continue;const c=quantColor(p[i],p[i+1],p[i+2]),k=c.join(',');colors.set(k,(colors.get(k)||0)+1);}
      const sorted=[...colors.entries()].sort((a,b)=>b[1]-a[1]);const chosen=[];
      for(const [key] of sorted){const c=key.split(',').map(Number);const far=chosen.every(v=>Math.sqrt(c.reduce((sum,n,i)=>sum+(n-v[i])**2,0))>55);
        if(far)chosen.push(c);if(chosen.length>=5)break;}
      return chosen.map(toHex);
    }catch {return [];}finally {bitmap?.close?.();}
  }
  async function ingest(files){
    let n=0;
    for(const file of files){
      if(!allowedTypes.has(file.type)){toast(`Übersprungen: ${file.name} (Typ nicht unterstützt)`);continue;}
      if(file.size>MAX_FILE){toast(`Übersprungen: ${file.name} (über 60 MB)`);continue;}
      const id=uid();
      try {await dbPut(id,file);
        const palette=await extractPalette(file);
        state.references.unshift({id,name:file.name,kind:file.type.startsWith('video/')?'video':'image',mime:file.type,size:file.size,palette,notes:'',source:'',likes:[],dislikes:[],createdAt:new Date().toISOString()});n++;
      } catch(e) {toast(`Speicherfehler für ${file.name} – Browser-Limit?`);console.error(e);}
    }
    persist();await renderReferences();renderContext();toast(`${n} Referenz${n===1?'':'en'} lokal gespeichert.`);
  }
  const fileInput=q('#referenceFiles');
  fileInput.addEventListener('change',async e=>{await ingest([...e.target.files]);e.target.value='';});
  const drop=q('#dropzone');
  drop.addEventListener('click',()=>fileInput.click());drop.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();fileInput.click();}});
  for(const event of ['dragover','dragenter'])drop.addEventListener(event,e=>{e.preventDefault();drop.classList.add('drag');});
  for(const event of ['dragleave','drop'])drop.addEventListener(event,e=>{e.preventDefault();drop.classList.remove('drag');});
  drop.addEventListener('drop',e=>ingest([...e.dataTransfer.files]));

  async function renderReferences(){
    mediaUrls.forEach(u=>URL.revokeObjectURL(u));mediaUrls=[];
    const refs=state.references;
    q('#refCountBig').innerHTML=`${String(refs.length).padStart(2,'0')} <span>REFERENZEN</span>`;
    q('#referenceCounter').textContent=`${refs.length} gespeicherte Referenzen`;
    const grid=q('#referenceGrid');
    if(!refs.length){grid.innerHTML='<div class="empty">Noch keine Referenzen. Lade Bilder, Designposter, Fotos oder Videos hoch und markiere, was du magst.</div>';return;}
    grid.innerHTML=refs.map(r=>`<article class="reference-card" data-id="${esc(r.id)}"><div class="ref-media"><div class="noimage">Vorschau wird geladen …</div></div><div class="ref-body"><div class="ref-name" title="${esc(r.name)}">${esc(r.name)}</div><div class="ref-info">${esc(r.notes?.slice(0,55)||r.likes?.slice(0,3).join(' · ')||'Noch nicht bewertet')}</div><div class="swatches">${(r.palette||[]).map(c=>`<span class="swatch" title="${esc(c)}" style="background:${/^#[\da-fA-F]{6}$/.test(c)?c:'#333'}"></span>`).join('')}</div><button class="button subtle small full" data-edit="${esc(r.id)}">Bewerten ↗</button></div></article>`).join('');
    qa('[data-edit]').forEach(b=>b.addEventListener('click',()=>editReference(b.dataset.edit)));
    for(const r of refs){
      const container=grid.querySelector(`[data-id="${r.id}"] .ref-media`);
      try{const blob=await dbGet(r.id);if(!blob){container.innerHTML='<span class="noimage">Datei im Browser fehlt</span>';continue;}
        const url=URL.createObjectURL(blob);mediaUrls.push(url);
        if(r.kind==='image'){const img=document.createElement('img');img.src=url;img.loading='lazy';img.alt='';container.replaceChildren(img);}
        else{const video=document.createElement('video');video.src=url;video.muted=true;video.playsInline=true;video.preload='metadata';video.controls=true;container.replaceChildren(video);}
      }catch{container.innerHTML='<span class="noimage">Vorschau nicht verfügbar</span>';}
    }
  }
  function editReference(id){
    const r=state.references.find(x=>x.id===id);if(!r)return;editingRef=id;q('#referenceEditor').classList.remove('hidden');
    q('#editingName').textContent=r.name;q('#refNotes').value=r.notes||'';q('#refSource').value=r.source||'';
    q('#refLikes').value=(r.likes||[]).join(', ');q('#refDislikes').value=(r.dislikes||[]).join(', ');
    q('#referenceEditor').scrollIntoView({behavior:'smooth',block:'start'});
  }
  q('#closeEditor').addEventListener('click',()=>q('#referenceEditor').classList.add('hidden'));
  q('#saveReference').addEventListener('click',async()=>{const r=state.references.find(x=>x.id===editingRef);if(!r)return;
    r.notes=q('#refNotes').value.trim();r.source=q('#refSource').value.trim();r.likes=csv(q('#refLikes').value);r.dislikes=csv(q('#refDislikes').value);
    persist();q('#referenceEditor').classList.add('hidden');await renderReferences();toast('Bewertung gespeichert.');});
  q('#deleteReference').addEventListener('click',async()=>{const r=state.references.find(x=>x.id===editingRef);if(!r)return;
    if(!confirm(`Referenz „${r.name}“ und die lokale Mediendatei löschen?`))return;
    await dbDelete(r.id);state.references=state.references.filter(x=>x.id!==editingRef);editingRef=null;persist();q('#referenceEditor').classList.add('hidden');await renderReferences();toast('Referenz gelöscht.');});

  function hydrateStyleForm(){
    const f=state.styleForm||{};q('#styleName').value=f.name||'';q('#styleTraits').value=f.traits||'';
    q('#styleTypography').value=f.typography||'';q('#styleMotion').value=f.motion||'';q('#styleAvoid').value=f.avoid||'';
    q('#voiceTraits').value=state.voice?.traits||'';q('#voiceAvoid').value=state.voice?.avoid||'';q('#voiceExample').value=state.voice?.example||'';
  }
  function saveForm(){state.styleForm={name:q('#styleName').value,traits:q('#styleTraits').value,typography:q('#styleTypography').value,motion:q('#styleMotion').value,avoid:q('#styleAvoid').value};persist();}
  function saveVoice(){state.voice={traits:q('#voiceTraits').value,avoid:q('#voiceAvoid').value,example:q('#voiceExample').value};persist();toast('Deine Voice-Regeln wurden gespeichert.');renderStyle();}
  q('#saveVoice').addEventListener('click',saveVoice);
  q('#generateStyle').addEventListener('click',()=>{
    saveForm();state.voice={traits:q('#voiceTraits').value,avoid:q('#voiceAvoid').value,example:q('#voiceExample').value};
    const approved=state.references.filter(r=>r.likes?.length);
    const palette=unique(approved.flatMap(r=>r.palette||[])).slice(0,6);
    const traits=unique([...csv(state.styleForm.traits),...approved.flatMap(r=>r.likes||[])]).slice(0,30);
    const avoid=unique([...csv(state.styleForm.avoid),...state.references.flatMap(r=>r.dislikes||[])]).slice(0,30);
    state.style={name:state.styleForm.name.trim()||'My Creator Style',version:(state.style?.version||0)+1,createdAt:new Date().toISOString(),approvedReferenceIds:approved.map(r=>r.id),
      visual:{palette,traits,avoid,typography:state.styleForm.typography,lighting:''},
      motion:{pacing:state.styleForm.motion||'Noch nicht festgelegt',transitions:[]},
      voice:{traits:csv(state.voice.traits),avoid:csv(state.voice.avoid),ownExamples:state.voice.example.trim()?[state.voice.example.trim()]:[]}};
    persist();renderStyle();toast(`Style Bible v${state.style.version} erstellt.`);
  });
  function renderStyle(){const s=state.style; if(!s){q('#styleOutput').innerHTML='<div class="output-placeholder">Noch keine Style Bible. Bewerte Referenzen oder definiere manuelle Eigenschaften und erstelle die erste Version.</div>';return;}
    q('#styleOutput').innerHTML=`<div class="eyebrow">CREATIVE DNA · VERSION ${s.version}</div><h2>${esc(s.name)}</h2>
      <div class="subhead">Farbwelt · technischer Vorschlag aus Referenzbildern</div>
      <div class="palette">${s.visual.palette.length?s.visual.palette.map(c=>`<div class="color-chip"><div class="color-sample" style="background:${c}"></div><div class="color-code">${esc(c)}</div></div>`).join(''):'<span class="hint">Keine Bildfarben verfügbar.</span>'}</div>
      <div class="subhead">Visuelle Eigenschaften</div><div class="tag-row">${s.visual.traits.length?s.visual.traits.map(t=>`<span class="tag">${esc(t)}</span>`).join(''):'<span class="hint">Noch keine festgelegt.</span>'}</div>
      <div class="subhead">Nicht erwünscht</div><div class="tag-row">${s.visual.avoid.length?s.visual.avoid.map(t=>`<span class="tag avoid">${esc(t)}</span>`).join(''):'<span class="hint">Noch nichts festgelegt.</span>'}</div>
      <div class="subhead">Typografie / Motion</div><p class="hint">${esc(s.visual.typography||'Typografie noch offen')} · ${esc(s.motion.pacing)}</p>
      <div class="subhead">Deine Voice</div><p class="hint">${esc(s.voice.traits.join(' · ')||'Noch keine Voice-Merkmale festgelegt.')}</p>
      <div class="note">Die Style Bible ist ein von dir freigegebener, manueller Stilvorschlag. Farben sind aus Bildpixeln abgeleitet, nicht aus einer multimodalen KI-Interpretation.</div>`;
  }
  q('#downloadBible').addEventListener('click',()=>state.style?downloadJson('creator-style-bible-v'+state.style.version+'.json',state.style):toast('Erst eine Style Bible erstellen.'));

  function hydrateBrief(){const b=state.brief; q('#contentMode').value=b.mode||'personal';q('#contentTopic').value=b.topic||'';
    q('#contentAudience').value=b.audience||'';q('#contentGoal').value=b.goal||'growth';q('#contentFacts').value=b.facts||'';q('#contentLength').value=b.length||30;}
  const normalizeText=(v,n=110)=>String(v||'').trim().replace(/\s+/g,' ').slice(0,n);
  function currentBrief(){return{mode:q('#contentMode').value,topic:normalizeText(q('#contentTopic').value,100),audience:normalizeText(q('#contentAudience').value,100),goal:q('#contentGoal').value,facts:normalizeText(q('#contentFacts').value,350),length:Number(q('#contentLength').value)};}
  function renderContext(){
    q('#contentContext').innerHTML=`<ul><li><strong>Style:</strong> ${esc(state.style?.name||'Noch keine Style Bible')} ${state.style?`(v${state.style.version})`:''}</li><li><strong>Voice:</strong> ${esc(csv(state.voice?.traits).join(' · ')||'Noch nicht kalibriert')}</li><li><strong>Referenzen:</strong> ${state.references.length} lokale Inspirationsquellen</li><li><strong>UGC:</strong> echte Produkterfahrung, keine erfundenen Claims</li><li><strong>Video:</strong> Hybrid (du + optionale KI-Assets)</li></ul>`;
    q('#growthContext').textContent=state.growthInsight?.hypothesis||'Noch keine Daten. Erstelle zunächst einen Post und erfasse später echte Insights.';
  }
  function buildConcepts(b){
    const subject=b.topic;
    const who=b.audience||'Menschen, die neugierig auf das Thema sind';
    const ugc=b.mode==='ugc';
    const start=ugc?`Was kannst du bei ${subject} tatsächlich erwarten?`:`Ich probiere gerade etwas mit ${subject} aus.`;
    return [
      {id:uid(),title:'Der klare Aha-Moment',kind:'PRODUKT / DEMO',hook:ugc?`So sieht ${subject} wirklich in der Anwendung aus.`:`Das ist der Teil an ${subject}, den ich spannend finde.`,angle:`Einstieg über eine konkrete Beobachtung, dann echte Anwendung zeigen. Für: ${who}.`,cta:ugc?'Das Produkt im Einsatz beurteilen und bei Bedarf mehr erfahren.':'Welche Details soll ich als Nächstes zeigen?',structure:['Beobachtbarer Einstieg','Problem oder Kontext','Echte Demonstration','Offene Frage / CTA']},
      {id:uid(),title:'Experiment mit offenem Ausgang',kind:'PROZESS / STORY',hook:ugc?`Ich teste heute ${subject} – ohne vorweggenommenes Fazit.`:`Was passiert, wenn ich ${subject} einfach mal anders angehe?`,angle:'Neugier und Prozess vor perfektem Ergebnis. Raum für kleine Überraschungen, keine künstlichen Behauptungen.',cta:'Was würdest du als Nächstes ausprobieren?',structure:['Frage','Setup und Erwartung','Experiment in kurzen Schritten','Tatsächlicher Zwischenstand']},
      {id:uid(),title:'Eine kleine persönliche Geschichte',kind:'BEHIND THE SCENES',hook:ugc?`Ein Blick hinter meinen echten Test von ${subject}.`:`Weshalb ich mich gerade mit ${subject} beschäftige.`,angle:'Persönlicher Zugang mit ruhigen Detailaufnahmen, wertschätzender Ehrlichkeit und einem kurzen Erkenntnismoment.',cta:'Welche Erfahrung hast du mit dem Thema?',structure:['Persönlicher Kontext','Was ich daran interessant finde','Echter Prozess / Produktdetail','Einladung zum Austausch']}
    ];
  }
  q('#generateConcepts').addEventListener('click',()=>{
    const b=currentBrief();if(!b.topic){toast('Bitte zuerst ein Produkt oder Thema eintragen.');q('#contentTopic').focus();return;}
    state.brief=b;state.concepts=buildConcepts(b);state.selectedConcept=null;state.script=null;persist();renderConcepts();q('#conceptsSection').scrollIntoView({behavior:'smooth',block:'start'});toast('Drei Demo-Konzepte erstellt.');
  });
  function renderConcepts(){const c=state.concepts;q('#conceptsSection').classList.toggle('hidden',!c.length);q('#scriptSection').classList.toggle('hidden',!state.script);
    q('#conceptsGrid').innerHTML=c.map((x,i)=>`<article class="concept"><div class="concept-no">0${i+1}</div><div class="kind">${esc(x.kind)}</div><h3>${esc(x.title)}</h3><p><b>Hook:</b> „${esc(x.hook)}“</p><p>${esc(x.angle)}</p><button class="button ${state.selectedConcept===x.id?'primary':'subtle'} full" data-pick="${esc(x.id)}">${state.selectedConcept===x.id?'Ausgewählt ✓':'Skript daraus bauen →'}</button></article>`).join('');
    qa('[data-pick]').forEach(btn=>btn.addEventListener('click',()=>selectConcept(btn.dataset.pick)));
    if(state.script)renderScript();
  }
  function selectConcept(id){const c=state.concepts.find(x=>x.id===id);if(!c)return;
    state.selectedConcept=id;const b=state.brief;const dur=b.length,beats=[Math.round(dur*.14),Math.round(dur*.34),Math.round(dur*.73),dur];
    const subject=b.topic,fact=b.facts||'';
    const lines=b.mode==='ugc'?
      [c.hook,`Ich zeige dir ${subject} in einer echten Aufnahme, nicht nur in Werbebildern.`,fact?`Wichtig ist: ${fact}`:'Hier zeige ich die tatsächlichen Details und den Ablauf – ohne unbelegte Produktversprechen.',`Schau dir die Anwendung an und entscheide selbst, was davon für dich relevant ist.`]:
      [c.hook,`Ich beschäftige mich gerade mit ${subject} und zeige dir den Prozess.`,fact?`Was ich bisher weiß: ${fact}`:'Ich filme die Details und schaue, was dabei tatsächlich passiert.',`Welche Frage dazu interessiert dich am meisten?`];
    const visual=['Talking Head oder sofortige Makroaufnahme mit Hook-Text','Echter Prozess / Produkt im Einsatz, Detailshots','B-Roll, Cutaways und Erklärung; optionale KI-Atmosphäre nur als klar kreative Ergänzung','Echtes Ergebnis oder offener Zwischenstand, dezenter CTA'];
    let t=0;const scenes=beats.map((end,i)=>{const s={startSecond:t,endSecond:end,dialogue:lines[i],visual:visual[i],origin:'real'};t=end;return s;});
    state.script={conceptId:id,conceptTitle:c.title,estimatedSeconds:dur,verifiedClaims:fact?[fact]:[],scenes,warnings:['Demo-Entwurf ohne KI. Wortmenge und Timing vor Aufnahme prüfen.','Persönliche Produkterfahrungen und Wirkversprechen nur verwenden, wenn tatsächlich belegbar.'],
      styleBibleVersion:state.style?.version??null,voiceTraits:csv(state.voice?.traits),growthInsight:state.growthInsight?.hypothesis||null};
    persist();renderConcepts();q('#scriptSection').scrollIntoView({behavior:'smooth',block:'start'});
  }
  function renderScript(){const s=state.script;if(!s)return;
    q('#scriptOutput').innerHTML=`<div class="eyebrow">${esc(s.conceptTitle)} · ${s.estimatedSeconds} SEKUNDEN · HYBRID</div>
      <div class="scenelist">${s.scenes.map(sc=>`<div class="scene"><div class="time">${sc.startSecond}–${sc.endSecond}s</div><div><div class="dialogue">„${esc(sc.dialogue)}“</div><div class="visual">◉ Real Footage · ${esc(sc.visual)}</div></div></div>`).join('')}</div>
      <div class="subhead">Creative Direction</div><p class="hint">Style: ${esc(state.style?.name||'Noch offen')} · Motion: ${esc(state.style?.motion?.pacing||'noch offen')} · Voice: ${esc(s.voiceTraits.join(', ')||'noch nicht kalibriert')}</p>
      <div class="subhead">Growth Input</div><p class="hint">${esc(s.growthInsight||'Noch keine vergleichbaren Insights vorhanden.')}</p>
      <div class="note">${s.warnings.map(esc).join(' ')}</div>`;
  }
  q('#exportScript').addEventListener('click',()=>state.script?downloadJson('ugc-script-demo.json',state.script):toast('Erst ein Skript erstellen.'));

  function readNum(id){const raw=q(id).value.trim();if(raw==='')return null;const n=Number(raw);return Number.isFinite(n)&&n>=0?Math.floor(n):null;}
  function measure(m){return m.reach>0?{savesPct:100*m.saves/m.reach,sharesPct:100*m.shares/m.reach,combinedPct:100*(m.saves+m.shares)/m.reach}:{savesPct:null,sharesPct:null,combinedPct:null};}
  function fmtPct(x){return x==null?'—':x.toFixed(2).replace('.',',')+' %';}
  q('#saveMetrics').addEventListener('click',()=>{
    const title=q('#metricTitle').value.trim(),reach=readNum('#metricReach'),views=readNum('#metricViews'),saves=readNum('#metricSaves'),shares=readNum('#metricShares');
    if(!title||[reach,views,saves,shares].some(v=>v==null)){toast('Bitte Titel und alle vier Kennzahlen korrekt eingeben.');return;}
    state.metrics.unshift({id:uid(),title:title.slice(0,100),hook:q('#metricHook').value.trim().slice(0,200),reach,views,saves,shares,age:q('#metricAge').value,observedAt:new Date().toISOString(),source:'manual'});
    q('#metricTitle').value='';q('#metricHook').value='';['#metricReach','#metricViews','#metricSaves','#metricShares'].forEach(id=>q(id).value='');
    updateGrowthInsight();persist();renderGrowth();renderContext();toast('Echter Messwert wurde gespeichert.');
  });
  function updateGrowthInsight(){
    const valid=state.metrics.filter(m=>m.reach>0);
    if(!valid.length){state.growthInsight=null;return;}
    const latest=valid[0];const peers=valid.filter(m=>m.age===latest.age);
    const best=[...peers].sort((a,b)=>measure(b).combinedPct-measure(a).combinedPct)[0];
    const metric=measure(best);state.growthInsight={sampleSize:peers.length,window:latest.age,postId:best.id,
      hypothesis:`Experiment-Hypothese: Teste erneut einen ${best.hook?`Hook im Ansatz „${best.hook}“`:'Einstieg zum Thema „'+best.title+'“'}, aber mit einem klar veränderten Detail (z. B. der ersten Einstellung). Dieser Beitrag hatte ${fmtPct(metric.combinedPct)} kombinierte Saves + Shares pro erreichten Accounts (${best.age}-Messfenster).`,
      caveat:peers.length<3?'Sehr kleine Datenbasis; daraus lässt sich noch kein verlässliches Muster ableiten.':'Beobachtungsdaten; Korrelation belegt keine Ursache.'};
  }
  function renderGrowth(){
    q('#metricCount').textContent=`${state.metrics.length} Beiträge`;
    const g=state.growthInsight;
    q('#growthSummary').innerHTML=g?`<div class="eyebrow">EXPERIMENT MEMORY</div><div class="growth-metric">${g.sampleSize} ${g.sampleSize===1?'Beitrag':'vergleichbare Beiträge'}</div><div class="growth-metric-sub">Messfenster: ${esc(g.window)}</div><p class="hint">${esc(g.hypothesis)}</p><div class="note">${esc(g.caveat)}</div>`:'<div class="output-placeholder">Noch keine Insights vorhanden. Trage den ersten Beitrag ein. Es werden keine Daten von Instagram abgerufen.</div>';
    q('#metricList').innerHTML=state.metrics.length?state.metrics.map(m=>{const v=measure(m);return `<div class="metric-card"><div class="metric-head"><b>${esc(m.title)}</b><button class="button subtle small" data-remove-metric="${esc(m.id)}">Entfernen ×</button></div><div class="metric-cols"><div class="metric-col"><strong>${number(m.reach)}</strong><span>Erreicht</span></div><div class="metric-col"><strong>${number(m.views)}</strong><span>Views</span></div><div class="metric-col"><strong>${fmtPct(v.savesPct)}</strong><span>Saves / Reach</span></div><div class="metric-col"><strong>${fmtPct(v.sharesPct)}</strong><span>Shares / Reach · ${esc(m.age)}</span></div></div></div>`;}).join(''):'<div class="empty">Noch keine Insights gespeichert.</div>';
    qa('[data-remove-metric]').forEach(b=>b.addEventListener('click',()=>{state.metrics=state.metrics.filter(m=>m.id!==b.dataset.removeMetric);updateGrowthInsight();persist();renderGrowth();renderContext();}));
  }
  q('#exportAll').addEventListener('click',()=>downloadJson('creator-studio-backup-'+today()+'.json',{
    ...state,backupNotice:'Metadaten-Backup ohne Medien-Binärdateien (liegen nur im Browser-IndexedDB).',exportedAt:new Date().toISOString()
  }));

  (async()=>{
    try {mediaDB=await openDb();}catch(e){console.error(e);toast('IndexedDB nicht verfügbar; bitte unter http://localhost starten.');}
    hydrateStyleForm();hydrateBrief();await renderReferences();renderStyle();renderContext();renderConcepts();updateGrowthInsight();renderGrowth();
  })();
})();
