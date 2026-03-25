
const RAW_BUILTIN = window.RAW_BUILTIN || '';
const PAGE_SIZE = 25;
const STORAGE_KEY = 'sup_main_dashboard_min';
const SLA_KEY = 'sup_main_dashboard_sla_min';
let tasks = [];
let selectedNum = null;
let currentPage = 1;
let activeStatusFilter = '';
let activeBoardSection = 'dashboards';
let taskStatusHistory = new Map();
let storedImports = [];
let infographicState = null;
let statusInfographicState = null;
let slaSettings = loadSlaSettings();
let createdCompletedChart = null;
let slaDonutChart = null;

function escapeHtml(v){return String(v ?? '').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
function parseDate(v){if(!v)return null; if(v instanceof Date)return isNaN(v)?null:v; const s=String(v).trim(); if(!s)return null; let m=s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/); if(m)return new Date(+m[3],+m[2]-1,+m[1],+(m[4]||0),+(m[5]||0)); m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/); if(m)return new Date(+m[3],+m[1]-1,+m[2],+(m[4]||0),+(m[5]||0)); const d=new Date(s); return isNaN(d)?null:d;}
function fmtDate(d){return d?new Intl.DateTimeFormat('uk-UA',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(d):'—';}
function fmtDateShort(d){return d?new Intl.DateTimeFormat('uk-UA',{day:'2-digit',month:'2-digit',year:'numeric'}).format(d):'—';}
function hoursBetween(a,b){return (!a||!b)?null:Math.max(0,(b-a)/36e5);} 
function serializeTask(t){return {...t,dateExec:t.dateExec?.toISOString()||null,dateFinished:t.dateFinished?.toISOString()||null,dateCreated:t.dateCreated?.toISOString()||null,ftrAssigned:t.ftrAssigned?.toISOString()||null,ftrAnswer:t.ftrAnswer?.toISOString()||null};}
function deserializeTask(t){return {...t,dateExec:parseDate(t.dateExec),dateFinished:parseDate(t.dateFinished),dateCreated:parseDate(t.dateCreated),ftrAssigned:parseDate(t.ftrAssigned),ftrAnswer:parseDate(t.ftrAnswer)};}
function loadSlaSettings(){try{return {...{hourStart:8,hourEnd:20,weekdays:[1,2,3,4,5],holidays:[],targetHours:12},...(JSON.parse(localStorage.getItem(SLA_KEY)||'{}'))};}catch{return {hourStart:8,hourEnd:20,weekdays:[1,2,3,4,5],holidays:[],targetHours:12};}}
function saveSla(){try{localStorage.setItem(SLA_KEY,JSON.stringify(slaSettings));}catch{}}
function saveState(){try{localStorage.setItem(STORAGE_KEY,JSON.stringify({tasks:tasks.map(serializeTask),storedImports,selectedNum,statusHistory:Array.from(taskStatusHistory.entries())}));}catch{}}
function loadState(){try{const s=JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}'); tasks=Array.isArray(s.tasks)?s.tasks.map(deserializeTask):[]; storedImports=Array.isArray(s.storedImports)?s.storedImports:[]; selectedNum=s.selectedNum||(tasks[0]?.num||null); taskStatusHistory=new Map(Array.isArray(s.statusHistory)?s.statusHistory:[]);}catch{}}
function setBoardSection(section){activeBoardSection=section; document.querySelectorAll('[data-board-section]').forEach(n=>n.classList.toggle('active',n.dataset.boardSection===section)); document.querySelectorAll('[data-board-tab]').forEach(n=>n.classList.toggle('active',n.dataset.boardTab===section)); document.querySelectorAll('[data-sidebar-tab]').forEach(n=>n.classList.toggle('is-active',n.dataset.sidebarTab===section));}
function buildDashboardLayout(){
  const main=document.querySelector('.supboard-workspace');
  if(!main)return;
  main.className='workspace supboard-workspace';
  main.innerHTML=`
    <header class="topbar supboard-topbar">
      <div class="supboard-topbar-copy">
        <div class="brand-kicker">SUPBOARD workspace</div>
        <h1 class="page-title">Операційний дашборд у єдиному каркасі SUP SPACE.</h1>
      </div>
      <div class="supboard-meta">
        <span class="pill is-primary supboard-count" id="headerCount">—</span>
        <span class="pill supboard-range" id="headerDateRange">—</span>
      </div>
    </header>

    <section class="content-panel supboard-panel">
      <div class="board-shell">
        <section class="board-section" data-board-section="dashboards">
          <div class="hero-grid">
            <div class="hero-card hero-copy">
              <div class="hero-eyebrow">Dashboards</div>
              <div class="hero-title">Головний зріз по задачах, періоду, джерелах і SLA.</div>
              <div class="hero-chips">
                <div class="hero-chip">
                  <div class="hero-chip-key">Період створення</div>
                  <div class="hero-chip-val" id="heroDateText">—</div>
                  <div class="hero-chip-sub">Діапазон задач у поточному зрізі.</div>
                </div>
                <div class="hero-chip">
                  <div class="hero-chip-key">Джерела</div>
                  <div class="hero-chip-val" id="heroSourceCount">0</div>
                  <div class="hero-chip-sub">Активні імпорти та підключені набори.</div>
                </div>
                <div class="hero-chip">
                  <div class="hero-chip-key">Ціль SLA</div>
                  <div class="hero-chip-val" id="heroSlaTarget">12 год</div>
                  <div class="hero-chip-sub" id="heroSlaSchedule">Робочі години та календар рахуються окремо.</div>
                </div>
              </div>
            </div>

            <div class="hero-card">
              <div class="analytics-grid" id="analyticsBar"></div>
            </div>
          </div>

          <div class="chart-grid">
            <div class="chart-card">
              <div class="chart-head">
                <div>
                  <h3 class="chart-title">Створені / завершені</h3>
                  <div class="chart-note">Порівняння кількості створених задач і завершених задач у поточному зрізі по днях.</div>
                </div>
              </div>
              <div class="chart-stage" id="createdCompletedChart"></div>
            </div>

            <div class="chart-card">
              <div class="chart-head">
                <div>
                  <h3 class="chart-title">SLA</h3>
                  <div class="chart-note">Доля задач, що вклались у SLA, проти задач, які вийшли за межі цілі.</div>
                </div>
              </div>
              <div class="chart-stage" id="slaDonutChart"></div>
            </div>
          </div>
        </section>

        <section class="board-section" data-board-section="details">
          <section class="workspace-grid">
            <div class="workspace-left">
              <div class="panel-card controls-card">
                <div class="panel-title">Фільтри та джерела</div>
                <div class="panel-copy">Старі модулі фільтрації й пошуку залишаємо без зміни логіки, просто збираємо їх у чистіший каркас.</div>
                <div class="search-wrap">
                  <span class="search-icon">⌕</span>
                  <input type="text" id="searchInput" placeholder="Пошук за номером або назвою..." oninput="renderAll()">
                </div>
                <div class="filter-section-title">Основні фільтри</div>
                <div class="filter-row">
                  <select id="statusFilter" onchange="renderAll()"><option value="">Всі статуси</option></select>
                  <select id="groupFilter" onchange="renderAll()"><option value="">Всі групи</option></select>
                </div>
                <div class="filter-row">
                  <select id="executorFilter" onchange="renderAll()"><option value="">Всі виконавці</option></select>
                  <select id="authorFilter" onchange="renderAll()"><option value="">Всі постановники</option></select>
                </div>
                <div class="filter-row">
                  <select id="slaFilter" onchange="renderAll()">
                    <option value="">Весь SLA</option>
                    <option value="fail">Тільки SLA fail</option>
                    <option value="ok">Тільки SLA ok</option>
                    <option value="progress">SLA в роботі</option>
                    <option value="no_data">Без SLA-даних</option>
                  </select>
                  <select id="sortBy" onchange="renderAll()">
                    <option value="date_desc">↓ Дата створення</option>
                    <option value="date_asc">↑ Дата створення</option>
                    <option value="num_desc">↓ Номер</option>
                    <option value="num_asc">↑ Номер</option>
                  </select>
                </div>
                <div class="filter-section-title">Дата створення</div>
                <div class="filter-stack">
                  <input type="date" id="dateFromFilter" onchange="renderAll()">
                  <input type="date" id="dateToFilter" onchange="renderAll()">
                </div>
                <div class="filter-stack">
                  <select id="sourceFilter" onchange="renderAll()"><option value="">Всі джерела</option></select>
                  <button class="btn" type="button" onclick="clearDateFilters()">Скинути дату</button>
                </div>
                <div class="mini-note" id="sourceSummary">Джерела даних зберігаються локально в browser storage.</div>
              </div>

              <div class="task-list-wrap">
                <div class="list-header"><span id="listCountLabel">Задачі</span><span id="listPageLabel"></span></div>
                <div class="task-list" id="taskList"></div>
                <div class="pagination" id="pagination"></div>
              </div>
            </div>

            <div class="workspace-right">
              <div class="panel-card">
                <div class="panel-title">Модулі деталізації</div>
                <div class="panel-copy">Тут лишаємо існуючі модулі без надлишкових віджетів: список задач, картку задачі й історію статусів.</div>
              </div>
              <div class="right-panel" id="rightPanel"></div>
            </div>
          </section>
        </section>

        <section class="board-section" data-board-section="admin">
          <section class="admin-grid">
            <div class="admin-stack">
              <div class="panel-card">
                <div class="panel-title">Адміністративні дії</div>
                <div class="panel-copy">Завантаження, SLA і очищення даних лишаються окремим сервісним шаром, без втручання в основний dashboard flow.</div>
                <div class="admin-actions">
                  <div class="admin-action">
                    <div class="admin-action-title">Завантаження</div>
                    <div class="admin-action-copy">Старі модулі імпорту через файл, папку, URL, paste і статусну історію вже підключені.</div>
                    <button class="btn-go" type="button" onclick="openModal()">Відкрити завантаження</button>
                  </div>
                  <div class="admin-action">
                    <div class="admin-action-title">SLA</div>
                    <div class="admin-action-copy">Налаштування робочих годин, свят, цілі SLA та правил підрахунку.</div>
                    <button class="btn" type="button" onclick="openSlaSettings()">Налаштувати SLA</button>
                  </div>
                  <div class="admin-action">
                    <div class="admin-action-title">Очистити</div>
                    <div class="admin-action-copy">Повний reset поточного набору задач і збережених імпортів.</div>
                    <button class="btn danger" type="button" onclick="confirmClear()">Очистити дані</button>
                  </div>
                </div>
              </div>
            </div>

            <div class="admin-stack">
              <div class="panel-card">
                <div class="panel-title">Збережені джерела</div>
                <div class="source-list" data-stored-sources></div>
                <div class="mini-note">Поки залишаємо підключення старих імпортів як є, а далі вже перевіримо скрипти по кожному каналу.</div>
              </div>
            </div>
          </section>
        </section>
      </div>
    </section>
  `;
  setBoardSection(activeBoardSection);
}
function populateFilters(){const fill=(id,vals,label)=>{const n=document.getElementById(id); if(!n)return; const cur=n.value; n.innerHTML=`<option value="">${label}</option>`+vals.map(v=>`<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join(''); n.value=vals.includes(cur)?cur:'';}; fill('statusFilter',[...new Set(tasks.map(t=>t.status).filter(Boolean))].sort(),'Всі статуси'); fill('groupFilter',[...new Set(tasks.map(t=>t.group).filter(Boolean))].sort(),'Всі групи'); fill('executorFilter',[...new Set(tasks.map(t=>t.executor).filter(Boolean))].sort(),'Всі виконавці'); fill('authorFilter',[...new Set(tasks.map(t=>t.author).filter(Boolean))].sort(),'Всі постановники'); fill('sourceFilter',[...new Set(tasks.map(t=>t.sourceName).filter(Boolean))].sort(),'Всі джерела');}
function parseRaw(text,sourceName='manual'){const rows=String(text||'').split(/\r?\n/).filter(Boolean).map(line=>line.split('\t')); if(!rows.length)return []; const hasHeader=rows[0]&&isNaN(Number((rows[0][0]||'').trim())); const body=hasHeader?rows.slice(1):rows; return body.map(r=>({num:String(r[0]||'').trim(),title:String(r[1]||'').trim(),status:String(r[2]||'').trim(),group:String(r[3]||'').trim(),author:String(r[4]||'').trim(),executor:String(r[5]||'').trim(),dateExec:parseDate(r[6]),dateFinished:parseDate(r[7]),dateCreated:parseDate(r[8]),ftrAssigned:parseDate(r[9]),ftrAnswer:parseDate(r[10]),sourceName})).filter(t=>t.num);}
function getFiltered(){const q=(document.getElementById('searchInput')?.value||'').toLowerCase().trim(); const status=document.getElementById('statusFilter')?.value||''; const group=document.getElementById('groupFilter')?.value||''; const executor=document.getElementById('executorFilter')?.value||''; const author=document.getElementById('authorFilter')?.value||''; const source=document.getElementById('sourceFilter')?.value||''; const sla=document.getElementById('slaFilter')?.value||''; const dateFrom=parseDate(document.getElementById('dateFromFilter')?.value||''); const dateTo=parseDate(document.getElementById('dateToFilter')?.value||''); const sortBy=document.getElementById('sortBy')?.value||'date_desc'; const filtered=tasks.filter(t=>{if(q&&!`${t.num} ${t.title}`.toLowerCase().includes(q))return false; if(activeStatusFilter&&activeStatusFilter!=='__sla_fail__'&&t.status!==activeStatusFilter)return false; if(status&&t.status!==status)return false; if(group&&t.group!==group)return false; if(executor&&t.executor!==executor)return false; if(author&&t.author!==author)return false; if(source&&t.sourceName!==source)return false; if(dateFrom&&(!t.dateCreated||t.dateCreated<dateFrom))return false; if(dateTo){const end=new Date(dateTo); end.setHours(23,59,59,999); if(!t.dateCreated||t.dateCreated>end)return false;} const slaHours=hoursBetween(t.dateCreated,t.dateFinished||t.dateExec); if(activeStatusFilter==='__sla_fail__'&&!(slaHours!==null&&slaHours>slaSettings.targetHours))return false; if(sla==='fail'&&!(slaHours!==null&&slaHours>slaSettings.targetHours))return false; if(sla==='ok'&&!(slaHours!==null&&slaHours<=slaSettings.targetHours))return false; if(sla==='progress'&&!(t.dateCreated&&!t.dateFinished))return false; if(sla==='no_data'&&slaHours!==null)return false; return true;}); filtered.sort((a,b)=>{if(sortBy==='num_asc')return Number(a.num)-Number(b.num); if(sortBy==='num_desc')return Number(b.num)-Number(a.num); const da=a.dateCreated?a.dateCreated.getTime():0; const db=b.dateCreated?b.dateCreated.getTime():0; return sortBy==='date_asc'?da-db:db-da;}); return filtered;}
function computeAnalytics(arr){const total=arr.length; const done=arr.filter(t=>t.status==='Завершене'||t.status==='Виконане').length; const withSla=arr.map(t=>hoursBetween(t.dateCreated,t.dateFinished||t.dateExec)).filter(v=>v!==null); const slaOk=withSla.filter(v=>v<=slaSettings.targetHours).length; const avgHours=withSla.length?Math.round(withSla.reduce((s,v)=>s+v,0)/withSla.length*10)/10:null; const firstReply=arr.map(t=>hoursBetween(t.ftrAssigned||t.dateCreated,t.ftrAnswer)).filter(v=>v!==null); const avgReply=firstReply.length?Math.round(firstReply.reduce((s,v)=>s+v,0)/firstReply.length*10)/10:null; return {total,done,slaOk,withSla:withSla.length,avgHours,avgReply};}
function renderAnalyticsBar(filtered){const a=computeAnalytics(filtered); const n=document.getElementById('analyticsBar'); if(!n)return; const cards=[['Всього задач',a.total||'0','Усі задачі у вибраному зрізі',''],['Завершено',a.done||'0','Завершені та виконані задачі','good'],['SLA OK',a.withSla?`${Math.round(a.slaOk/a.withSla*100)}%`:'—','Частка задач у межах SLA',a.withSla?'good':''],['Сер. виконання',a.avgHours!==null?`${a.avgHours} год`:'—','Середній час до виконання',a.avgHours!==null?'warn':''],['Перша відповідь',a.avgReply!==null?`${a.avgReply} год`:'—','Середній час до FTR відповіді',a.avgReply!==null?'warn':''],['Джерела',String(new Set(filtered.map(t=>t.sourceName).filter(Boolean)).size),'Кількість активних джерел','']]; n.innerHTML=cards.map(([label,value,sub,tone])=>`<div class="metric-card"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value ${tone}">${escapeHtml(value)}</div><div class="metric-sub">${escapeHtml(sub)}</div></div>`).join('');}
function toggleStatusFilter(status){activeStatusFilter=activeStatusFilter===status?'':status; currentPage=1; renderAll();}
function renderStats(filtered){const n=document.getElementById('statsGrid'); if(!n)return; const items=[['Всі задачі',filtered.length,''],['Нові',filtered.filter(t=>t.status==='Нове').length,'Нове'],['В роботі',filtered.filter(t=>t.status==='В роботі').length,'В роботі'],['Очікують',filtered.filter(t=>t.status==='Очікує на відповідь').length,'Очікує на відповідь'],['Завершені',filtered.filter(t=>t.status==='Завершене'||t.status==='Виконане').length,'Завершене'],['SLA fail',filtered.filter(t=>{const v=hoursBetween(t.dateCreated,t.dateFinished||t.dateExec); return v!==null&&v>slaSettings.targetHours;}).length,'__sla_fail__']]; n.innerHTML=items.map(([label,value,status])=>`<button class="stat-card ${activeStatusFilter===status?'active':''}" type="button" onclick="toggleStatusFilter('${status}')"><div class="stat-val">${escapeHtml(String(value))}</div><div class="stat-lbl">${escapeHtml(label)}</div></button>`).join('');}
function formatChartDay(date){return new Intl.DateTimeFormat('uk-UA',{day:'2-digit',month:'2-digit'}).format(date);}
function buildCreatedCompletedSeries(filtered){
  const bucket=new Map();
  filtered.forEach(task=>{
    if(task.dateCreated){
      const key=task.dateCreated.toISOString().slice(0,10);
      if(!bucket.has(key))bucket.set(key,{created:0,completed:0,date:new Date(task.dateCreated.getFullYear(),task.dateCreated.getMonth(),task.dateCreated.getDate())});
      bucket.get(key).created+=1;
    }
    const completedDate=task.dateFinished||task.dateExec;
    if(completedDate&&(task.status==='Завершене'||task.status==='Виконане')){
      const key=completedDate.toISOString().slice(0,10);
      if(!bucket.has(key))bucket.set(key,{created:0,completed:0,date:new Date(completedDate.getFullYear(),completedDate.getMonth(),completedDate.getDate())});
      bucket.get(key).completed+=1;
    }
  });
  const rows=Array.from(bucket.values()).sort((a,b)=>a.date-b.date);
  return {categories:rows.map(row=>formatChartDay(row.date)),created:rows.map(row=>row.created),completed:rows.map(row=>row.completed)};
}
function renderCreatedCompletedChart(filtered){
  const node=document.getElementById('createdCompletedChart');
  if(!node||typeof ApexCharts==='undefined')return;
  const data=buildCreatedCompletedSeries(filtered);
  const options={
    chart:{type:'area',height:320,toolbar:{show:false},zoom:{enabled:false},background:'transparent',foreColor:'#94A3B8'},
    series:[{name:'Створені',data:data.created},{name:'Завершені',data:data.completed}],
    colors:['#22C55E','#EF4444'],
    stroke:{curve:'smooth',width:3},
    fill:{type:'gradient',gradient:{shade:'dark',opacityFrom:0.28,opacityTo:0.04,stops:[0,90,100]}},
    markers:{size:0,hover:{size:5}},
    dataLabels:{enabled:false},
    grid:{borderColor:'#1E293B',strokeDashArray:4},
    legend:{position:'top',horizontalAlign:'left',labels:{colors:'#94A3B8'}},
    xaxis:{categories:data.categories,labels:{style:{colors:'#64748B',fontFamily:'Ubuntu Mono'}},axisBorder:{show:false},axisTicks:{show:false}},
    yaxis:{min:0,forceNiceScale:true,labels:{style:{colors:'#64748B',fontFamily:'Ubuntu Mono'}}},
    tooltip:{theme:'dark'},
    noData:{text:'Ще немає даних для графіка',style:{color:'#94A3B8'}}
  };
  if(createdCompletedChart){createdCompletedChart.updateOptions(options,true,true); createdCompletedChart.updateSeries(options.series,true);}
  else{createdCompletedChart=new ApexCharts(node,options); createdCompletedChart.render();}
}
function renderSlaDonutChart(filtered){
  const node=document.getElementById('slaDonutChart');
  if(!node||typeof ApexCharts==='undefined')return;
  const slaValues=filtered.map(task=>hoursBetween(task.dateCreated,task.dateFinished||task.dateExec)).filter(v=>v!==null);
  const ok=slaValues.filter(v=>v<=slaSettings.targetHours).length;
  const fail=slaValues.filter(v=>v>slaSettings.targetHours).length;
  const total=ok+fail;
  const okPercent=total?Math.round(ok/total*100):0;
  const failPercent=total?100-okPercent:0;
  const options={
    chart:{type:'donut',height:320,background:'transparent',foreColor:'#94A3B8'},
    series:total?[okPercent,failPercent]:[100,0],
    labels:['SLA виконаний','SLA не виконаний'],
    colors:['#22C55E','#F59E0B'],
    legend:{position:'bottom',labels:{colors:'#94A3B8'}},
    stroke:{width:0},
    dataLabels:{enabled:false},
    plotOptions:{pie:{donut:{size:'72%',labels:{show:true,name:{show:true,color:'#94A3B8'},value:{show:true,color:'#E2E8F0',fontSize:'28px',fontWeight:700,formatter:(value)=>`${Math.round(Number(value)||0)}%`},total:{show:true,color:'#E2E8F0',label:'SLA OK',formatter:()=>`${okPercent}%`}}}}},
    tooltip:{theme:'dark',y:{formatter:(value)=>`${Math.round(Number(value)||0)}%`}},
    noData:{text:'Ще немає SLA-даних',style:{color:'#94A3B8'}}
  };
  if(slaDonutChart){slaDonutChart.updateOptions(options,true,true); slaDonutChart.updateSeries(options.series,true);}
  else{slaDonutChart=new ApexCharts(node,options); slaDonutChart.render();}
}
function goToPage(page){currentPage=page; renderAll();}
function selectTask(num){selectedNum=num; saveState(); renderAll();}
function renderList(filtered){const list=document.getElementById('taskList'),countLabel=document.getElementById('listCountLabel'),pageLabel=document.getElementById('listPageLabel'),pagination=document.getElementById('pagination'); if(!list||!countLabel||!pageLabel||!pagination)return; const totalPages=Math.max(1,Math.ceil(filtered.length/PAGE_SIZE)); currentPage=Math.min(currentPage,totalPages); const start=(currentPage-1)*PAGE_SIZE; const pageItems=filtered.slice(start,start+PAGE_SIZE); countLabel.textContent=`Задачі · ${filtered.length}`; pageLabel.textContent=`Сторінка ${currentPage} / ${totalPages}`; list.innerHTML=pageItems.length?pageItems.map(t=>`<div class="task-item ${selectedNum===t.num?'active':''}" onclick="selectTask('${escapeHtml(t.num)}')"><div class="task-num">#${escapeHtml(t.num)}</div><div class="task-name">${escapeHtml(t.title||'Без назви')}</div><div class="task-item-badges"><span class="badge ${({'Завершене':'b-done','Нове':'b-new','Скасоване':'b-cancel','Відкладене':'b-wait','Очікує на відповідь':'b-wait','Виконане':'b-exec','В роботі':'b-work'}[t.status]||'b-other')}">${escapeHtml(t.status||'—')}</span></div></div>`).join(''):'<div class="no-results"><div>Немає задач за поточними фільтрами</div></div>'; pagination.innerHTML=`<div>${filtered.length?`Показано ${start+1}-${Math.min(start+PAGE_SIZE,filtered.length)}`:'0 результатів'}</div><div class="page-btns"><button class="page-btn" ${currentPage<=1?'disabled':''} onclick="goToPage(${currentPage-1})">Назад</button><button class="page-btn" ${currentPage>=totalPages?'disabled':''} onclick="goToPage(${currentPage+1})">Далі</button></div>`;}
function buildStatusHistory(task){const items=taskStatusHistory.get(task.num)||[]; return items.length?`<div class="timeline">${items.map((item,index)=>`<div class="tl-step ${index<items.length-1?'stuck':''}"><div class="tl-left"><div class="tl-dot-wrap tl-dot-done">${index+1}</div><div class="tl-line ${index<items.length-1?'done-line':''}"></div></div><div class="tl-body"><div class="tl-label">${escapeHtml(item.status||'—')}</div><div class="tl-date">${escapeHtml(fmtDate(parseDate(item.date)))}</div></div></div>`).join('')}</div>`:'<div class="timeline-chart-empty">Історія статусів ще не завантажена для цієї задачі.</div>';}
function renderRoadmap(){const node=document.getElementById('rightPanel'); if(!node)return; const task=tasks.find(item=>item.num===selectedNum); if(!task){node.innerHTML=`<div class="roadmap-empty" id="emptyState"><div class="roadmap-empty-icon">◌</div><div class="roadmap-empty-text">Оберіть задачу, щоб подивитися хронологію та деталі</div></div>`; return;} const totalHours=hoursBetween(task.dateCreated,task.dateFinished||task.dateExec); const slaState=totalHours===null?'pending':totalHours<=slaSettings.targetHours?'ok':'bad'; node.innerHTML=`<div class="panel-card"><div class="panel-title">Картка задачі</div><div class="task-detail-title">#${escapeHtml(task.num)} · ${escapeHtml(task.title||'Без назви')}</div><div class="detail-badges"><span class="badge ${({'Завершене':'b-done','Нове':'b-new','Скасоване':'b-cancel','Відкладене':'b-wait','Очікує на відповідь':'b-wait','Виконане':'b-exec','В роботі':'b-work'}[task.status]||'b-other')}">${escapeHtml(task.status||'—')}</span><span class="sla-state-badge sla-state-${slaState}">${slaState==='ok'?'SLA OK':slaState==='bad'?'SLA fail':'SLA в роботі'}</span></div><div class="detail-meta"><div class="meta-item"><div class="meta-key">Постановник</div><div class="meta-val">${escapeHtml(task.author||'—')}</div></div><div class="meta-item"><div class="meta-key">Виконавець</div><div class="meta-val">${escapeHtml(task.executor||'—')}</div></div><div class="meta-item"><div class="meta-key">Створено</div><div class="meta-val">${escapeHtml(fmtDate(task.dateCreated))}</div></div><div class="meta-item"><div class="meta-key">Завершено</div><div class="meta-val">${escapeHtml(fmtDate(task.dateFinished||task.dateExec))}</div></div></div><div class="roadmap-history"><div class="history-title">Історія статусів</div>${buildStatusHistory(task)}</div></div>`;}
function computeLeaderboard(filtered,field){const bucket=new Map(); filtered.forEach(task=>{const name=task[field]; if(!name)return; if(!bucket.has(name))bucket.set(name,{name,done:0,avgSource:[],slaTotal:0}); const row=bucket.get(name); if(task.status==='Завершене'||task.status==='Виконане')row.done+=1; const hours=hoursBetween(task.dateCreated,task.dateFinished||task.dateExec); if(hours!==null){row.avgSource.push(hours); if(hours<=slaSettings.targetHours)row.slaTotal+=1;}}); return Array.from(bucket.values()).map(item=>({name:item.name,done:item.done,sla:item.avgSource.length?Math.round(item.slaTotal/item.avgSource.length*100):0,avg:item.avgSource.length?Math.round(item.avgSource.reduce((s,v)=>s+v,0)/item.avgSource.length*10)/10:null})).sort((a,b)=>b.done-a.done||b.sla-a.sla).slice(0,8);}
function buildLeaderboard(items){return items.length?`<div class="leaderboard-row head"><div>#</div><div>Ім'я</div><div>Завершено</div><div>SLA</div><div>Сер. час</div></div>`+items.map((item,index)=>`<div class="leaderboard-row"><div class="leaderboard-rank">${index+1}</div><div class="leaderboard-name">${escapeHtml(item.name)}</div><div class="leaderboard-meta">${item.done}</div><div class="leaderboard-meta">${item.sla}%</div><div class="leaderboard-meta">${item.avg===null?'—':item.avg+' год'}</div></div>`).join(''):'<div class="leaderboard-empty">Даних ще недостатньо для рейтингу.</div>';}
function renderLeaderboards(filtered){const e=document.getElementById('executorLeaderboard'); const a=document.getElementById('authorLeaderboard'); if(e)e.innerHTML=buildLeaderboard(computeLeaderboard(filtered,'executor')); if(a)a.innerHTML=buildLeaderboard(computeLeaderboard(filtered,'author'));}
function updateHero(filtered){const dates=filtered.map(t=>t.dateCreated).filter(Boolean).sort((a,b)=>a-b); const heroDate=document.getElementById('heroDateText'); const heroSources=document.getElementById('heroSourceCount'); const heroTarget=document.getElementById('heroSlaTarget'); const heroSchedule=document.getElementById('heroSlaSchedule'); const headerCount=document.getElementById('headerCount'); const headerDateRange=document.getElementById('headerDateRange'); if(heroDate)heroDate.textContent=dates.length?`${fmtDateShort(dates[0])} → ${fmtDateShort(dates[dates.length-1])}`:'—'; if(heroSources)heroSources.textContent=String(new Set(filtered.map(t=>t.sourceName).filter(Boolean)).size); if(heroTarget)heroTarget.textContent=`${slaSettings.targetHours} год`; if(heroSchedule)heroSchedule.textContent=`${slaSettings.hourStart}:00 — ${slaSettings.hourEnd}:00 · ${slaSettings.weekdays.length} робочих днів`; if(headerCount)headerCount.textContent=`${filtered.length} задач у зрізі`; if(headerDateRange)headerDateRange.textContent=dates.length?`${fmtDateShort(dates[0])} — ${fmtDateShort(dates[dates.length-1])}`:'Немає дат';}
function renderStoredSources(){const markup=storedImports.length?storedImports.map(item=>`<div class="source-chip"><span>${escapeHtml(item.name)} · ${item.count||0}</span><button type="button" onclick="removeStoredImport('${escapeHtml(item.id)}')">×</button></div>`).join(''):'<div class="leaderboard-empty">Ще немає збережених імпортів.</div>'; document.querySelectorAll('[data-stored-sources]').forEach(node=>{node.innerHTML=markup;}); const summary=document.getElementById('sourceSummary'); if(summary)summary.textContent=storedImports.length?`Збережено ${storedImports.length} джерел для повторного використання.`:'Джерела даних зберігаються локально в browser storage.';}
function removeStoredImport(id){storedImports=storedImports.filter(item=>item.id!==id); tasks=tasks.filter(task=>task.sourceId!==id); selectedNum=tasks[0]?.num||null; saveState(); renderAll();}
function renderAll(){populateFilters(); const filtered=getFiltered(); updateHero(filtered); renderAnalyticsBar(filtered); renderStats(filtered); renderCreatedCompletedChart(filtered); renderSlaDonutChart(filtered); renderList(filtered); renderRoadmap(); renderLeaderboards(filtered); renderStoredSources();}
function clearDateFilters(){const from=document.getElementById('dateFromFilter'); const to=document.getElementById('dateToFilter'); if(from)from.value=''; if(to)to.value=''; renderAll();}
function applyTasks(parsed,sourceMeta){const sourceId=sourceMeta.id; tasks=tasks.filter(task=>task.sourceId!==sourceId).concat(parsed.map(task=>({...task,sourceId}))); tasks.sort((a,b)=>Number(b.num)-Number(a.num)); storedImports=storedImports.filter(item=>item.id!==sourceId).concat([{...sourceMeta,count:parsed.length}]); selectedNum=tasks[0]?.num||null; currentPage=1; saveState(); renderAll();}
function setModalMessage(id,kind,text){const node=document.getElementById(id); if(!node)return; node.className=`modal-msg ${kind}`; node.textContent=text;}
function switchModalTab(tab,trigger){document.querySelectorAll('.modal-tab').forEach(node=>node.classList.toggle('active',node===trigger)); document.querySelectorAll('.modal-section').forEach(node=>node.classList.toggle('active',node.id===`tab-${tab}`));}
function openModal(){document.getElementById('modalOverlay').classList.remove('hidden');}
function closeModal(){document.getElementById('modalOverlay').classList.add('hidden');}
function confirmClear(){document.getElementById('confirmOverlay').classList.remove('hidden');}
function closeConfirm(){document.getElementById('confirmOverlay').classList.add('hidden');}
function clearData(){tasks=[]; storedImports=[]; selectedNum=null; currentPage=1; taskStatusHistory=new Map(); saveState(); closeConfirm(); renderAll();}
function openSlaSettings(){hydrateSlaForm(); document.getElementById('slaOverlay').classList.remove('hidden');}
function closeSlaSettings(){document.getElementById('slaOverlay').classList.add('hidden');}
function readFileAsText(file){return new Promise((resolve,reject)=>{const reader=new FileReader(); reader.onload=e=>resolve(String(e.target.result||'')); reader.onerror=reject; reader.readAsText(file,'UTF-8');});}
async function handleFileInput(input){const file=input.files&&input.files[0]; if(!file)return; const text=await readFileAsText(file); const parsed=parseRaw(text,file.name); applyTasks(parsed,{id:`file_${Date.now()}`,name:file.name,text}); setModalMessage('msg-file','success',`Імпортовано ${parsed.length} задач із файлу ${file.name}.`);}
async function handleFolderInput(input){const files=Array.from(input.files||[]); if(!files.length)return; const merged=[]; for(const file of files){const text=await readFileAsText(file); merged.push(...parseRaw(text,file.webkitRelativePath||file.name));} applyTasks(merged,{id:`folder_${Date.now()}`,name:files[0].webkitRelativePath?.split('/')[0]||'folder import',text:''}); setModalMessage('msg-folder','success',`Імпортовано ${merged.length} задач із папки.`);}
function pickDataDirectory(){document.getElementById('folderInput')?.click();}
function restoreStoredImports(){renderStoredSources(); setModalMessage('msg-folder','info','Збережені імпорти вже доступні в адміністративному розділі та локальному стані браузера.');}
async function loadFromUrl(){const url=document.getElementById('urlInput').value.trim(); if(!url)return; try{const response=await fetch(url); if(!response.ok)throw new Error('Не вдалося завантажити URL'); const text=await response.text(); const parsed=parseRaw(text,url); applyTasks(parsed,{id:`url_${Date.now()}`,name:url,text}); setModalMessage('msg-url','success',`Імпортовано ${parsed.length} задач з URL.`);}catch(error){setModalMessage('msg-url','error',error.message||'Помилка завантаження URL.');}}
function loadFromPaste(){const text=document.getElementById('pasteInput').value; const parsed=parseRaw(text,'paste'); applyTasks(parsed,{id:`paste_${Date.now()}`,name:'Вставлений текст',text}); setModalMessage('msg-paste','success',`Імпортовано ${parsed.length} задач із вставленого тексту.`);}
function parseStatusHistory(text){return String(text||'').split(/\r?\n/).filter(Boolean).map(line=>line.split('\t')).map(parts=>({num:String(parts[0]||'').trim(),date:String(parts[1]||'').trim(),status:String(parts[2]||'').trim()})).filter(item=>item.num&&item.status);}
function saveStatusHistory(records){const grouped=new Map(taskStatusHistory); records.forEach(item=>{if(!grouped.has(item.num))grouped.set(item.num,[]); grouped.get(item.num).push({date:item.date,status:item.status});}); grouped.forEach(items=>items.sort((a,b)=>(parseDate(a.date)?.getTime()||0)-(parseDate(b.date)?.getTime()||0))); taskStatusHistory=grouped; saveState(); renderAll();}
async function handleStatusHistoryFile(input){const file=input.files&&input.files[0]; if(!file)return; const text=await readFileAsText(file); const parsed=parseStatusHistory(text); saveStatusHistory(parsed); setModalMessage('msg-history','success',`Імпортовано ${parsed.length} записів історії статусів.`);}
function loadStatusHistoryFromPaste(){const text=document.getElementById('statusHistoryPasteInput').value; const parsed=parseStatusHistory(text); saveStatusHistory(parsed); setModalMessage('msg-history','success',`Імпортовано ${parsed.length} записів історії статусів.`);}
function hydrateSlaForm(){document.getElementById('slaHourStart').value=slaSettings.hourStart; document.getElementById('slaHourEnd').value=slaSettings.hourEnd; document.getElementById('slaTargetHours').value=slaSettings.targetHours; document.getElementById('slaWeekdays').innerHTML=['Нд','Пн','Вт','Ср','Чт','Пт','Сб'].map((label,index)=>`<button type="button" class="wd-btn ${slaSettings.weekdays.includes(index)?'on':''}" onclick="toggleWeekday(${index})">${label}</button>`).join(''); renderHolidayList();}
function toggleWeekday(index){if(slaSettings.weekdays.includes(index)){slaSettings.weekdays=slaSettings.weekdays.filter(day=>day!==index);}else{slaSettings.weekdays=[...slaSettings.weekdays,index].sort();} hydrateSlaForm();}
function renderHolidayList(){const node=document.getElementById('slaHolidayList'); if(!node)return; node.innerHTML=slaSettings.holidays.length?slaSettings.holidays.map(day=>`<span class="holiday-tag">${escapeHtml(day)} <button type="button" onclick="removeHoliday('${escapeHtml(day)}')">×</button></span>`).join(''):'<span class="mini-note">Святкові дні ще не додані.</span>';}
function addHoliday(){const input=document.getElementById('slaHolidayInput'); const value=input.value.trim(); if(!value)return; if(!slaSettings.holidays.includes(value))slaSettings.holidays.push(value); input.value=''; renderHolidayList();}
function removeHoliday(value){slaSettings.holidays=slaSettings.holidays.filter(day=>day!==value); renderHolidayList();}
function resetSlaSettings(){slaSettings={hourStart:8,hourEnd:20,weekdays:[1,2,3,4,5],holidays:[],targetHours:12}; hydrateSlaForm();}
function saveSlaSettings(){slaSettings={hourStart:Number(document.getElementById('slaHourStart').value||8),hourEnd:Number(document.getElementById('slaHourEnd').value||20),targetHours:Number(document.getElementById('slaTargetHours').value||12),weekdays:[...slaSettings.weekdays],holidays:[...slaSettings.holidays]}; saveSla(); const msg=document.getElementById('msg-sla'); if(msg){msg.className='modal-msg success'; msg.textContent='Налаштування SLA збережено.';} renderAll();}
function buildSvgCard(title,lines){const height=220+lines.length*26; const rows=lines.map((line,index)=>`<text x="36" y="${90+index*26}" fill="#f5efff" font-size="15" font-family="Verdana">${escapeHtml(line)}</text>`).join(''); return `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${height}" viewBox="0 0 1200 ${height}"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#10002b"/><stop offset="100%" stop-color="#7b2cbf"/></linearGradient></defs><rect width="1200" height="${height}" rx="34" fill="url(#bg)"/><text x="36" y="48" fill="#ffffff" font-size="28" font-family="Verdana" font-weight="700">SUPBOARD</text><text x="36" y="74" fill="#e0aaff" font-size="18" font-family="Verdana">${title}</text>${rows}</svg>`)}`;}
function generateInfographic(){const a=computeAnalytics(getFiltered()); infographicState=buildSvgCard('KPI Snapshot',[`Всього задач: ${a.total}`,`Завершено: ${a.done}`,`SLA OK: ${a.withSla?Math.round(a.slaOk/a.withSla*100):0}%`,`Сер. виконання: ${a.avgHours===null?'—':a.avgHours+' год'}`,`Перша відповідь: ${a.avgReply===null?'—':a.avgReply+' год'}`]); document.getElementById('infographicPreviewStage').innerHTML=`<img alt="KPI Snapshot" src="${infographicState}">`;}
function generateStatusInfographic(){const counts=new Map(); getFiltered().forEach(task=>counts.set(task.status||'—',(counts.get(task.status||'—')||0)+1)); const lines=Array.from(counts.entries()).sort((a,b)=>b[1]-a[1]).map(([status,count])=>`${status}: ${count}`); statusInfographicState=buildSvgCard('Status Bottlenecks',lines.length?lines:['Немає даних для побудови.']); document.getElementById('statusInfographicPreviewStage').innerHTML=`<img alt="Status Bottlenecks" src="${statusInfographicState}">`;}
function downloadDataUri(dataUri,fileName){if(!dataUri)return; const link=document.createElement('a'); link.href=dataUri; link.download=fileName; link.click();}
function downloadInfographic(format){downloadDataUri(infographicState,`supboard-kpi.${format==='jpg'?'svg':'svg'}`);}
function downloadStatusInfographic(format){downloadDataUri(statusInfographicState,`supboard-status.${format==='jpg'?'svg':'svg'}`);}
function setupDropZones(){const dropZone=document.getElementById('dropZone'); if(!dropZone)return; ['dragenter','dragover'].forEach(name=>dropZone.addEventListener(name,event=>{event.preventDefault(); dropZone.classList.add('dragover');})); ['dragleave','drop'].forEach(name=>dropZone.addEventListener(name,event=>{event.preventDefault(); dropZone.classList.remove('dragover');})); dropZone.addEventListener('drop',async event=>{const file=event.dataTransfer.files&&event.dataTransfer.files[0]; if(!file)return; await handleFileInput({files:[file]});});}
function bootstrap(){buildDashboardLayout(); loadState(); if(!tasks.length&&RAW_BUILTIN){const parsed=parseRaw(RAW_BUILTIN,'built-in'); applyTasks(parsed,{id:'builtin',name:'built-in',text:RAW_BUILTIN});} setupDropZones(); renderAll();}
bootstrap();

