import {observe,feedback,archiveRound,reverseRounds,markdown,concise,attentionState,trackAttention,shouldNudge,attentionText,decisiveOpportunity,assessDecision,watchCandidate,readArchive,taskStamp,taskIsCurrent} from './coach/experience.js';
import {requestCoach,connectionStatus,invalidateCoachRequests} from './coach/client.js';
import {teacher,reviewMatch} from './coach/teacher.js';
import {rosterAdvice,strategist} from './coach/strategist.js';
import {buildContext,MATCH_REVIEW_REQUEST} from './coach/runtime.js';
import {freshMemory,readMemory,rememberBattle,recordCoachEvent,rememberDecision,adaptiveGate,memorySummary,deleteMemoryEvidence} from './coach/memory.js';
import {STAGES,SCENARIOS,stageOptions,createScenario} from './content.js';
import {DIFFICULTIES,SPECIES,SKILLS,ITEMS,TYPES,HELD_ITEMS,createGame,step,resolveTurn,chooseEnemy,buildVersusOpponent,legalActions,active,effectiveSpeed,rankEnemyActions} from './engine.js';
import {companionEvents} from './coach/companion.js';
import {newProfile,loadProfile,TRAINING,trainingCapacity,MAX_STAT_TRAINING,train,resetTraining,settle,configurePet} from './progression.js';
import {coachEvent,coachContext} from './coach.js';
import {rulesSections,ruleFacts} from './rules.js';
const $=id=>document.getElementById(id),storageKey='pet-coach-growth-v1';
let profile=newProfile();try{profile=loadProfile(localStorage.getItem(storageKey));}catch{$('save-message').textContent='浏览器存储不可用，本次成长只能保留到页面关闭。';}
let coachMemory=freshMemory(),coachRole='auto',asking=false,conversation=[],contextEpoch=0;try{coachMemory=readMemory(localStorage.getItem('xiaoya-memory-v1'));}catch{}
function advanceContext(){contextEpoch++;invalidateCoachRequests();}
function saveCoachMemory(){if(preview)return;try{localStorage.setItem('xiaoya-memory-v1',JSON.stringify(coachMemory));}catch{}}
let roundArchive=null,currentHint=null,lastFeedback=null,autoCalls=0,lastAutoReason=null,hintEpoch=0,visibleHintReason=null,visibleHintTurn=-10,coachMuted=false;try{roundArchive=readArchive(localStorage.getItem('xiaoya-last-round'));}catch{}
let attention=attentionState(Date.now()),hoverAction=null,nudgeTimer=null,tacticalShown=new Set(),tacticalCount=0,lastTacticalTurn=-10;let growthDismissed=null;
let rosterType='all',loadoutDraft=null,loadoutOpen=false;
// 本地对战：真人对手走分屏同屏（双方各选一招，都锁定后一起结算）；
// 电脑对手单人玩，由引擎 chooseEnemy 出招。pvpPicks 由分屏逻辑维护。
let matchMode='pve',pvpOpponent='ai',enemyTab='skill';
// 对局的对手有两种：AI 扮演真人（单人演示，自动配队、先手独立决定），
// 或真人同机（分屏，两侧面板都可操作）。界面两者一致。
let pvpEnemyLocked=null,pvpEnemyRevealed=false;
let bubbleTimer,stageId='meadow',preview=null,suspended=null;
let selected=['fox','turtle','deer'],focus='fox',game=null,tab='skill',busy=false,matchId='',reward=null,coachSession={count:0,lastTurn:null,dismissed:false},faintShown=false,resultAnnounced=false;
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const badge=p=>`<span class="type ${p.type}">${TYPES[p.type]}</span>`;
function save(){try{localStorage.setItem(storageKey,JSON.stringify(profile));}catch{$('save-message').textContent='保存失败：当前成长仍可使用，刷新后可能丢失。';}wallet();}
function wallet(){$('wallet').textContent=`训练点 ${profile.tokens}`;$('record').textContent=`完成 ${profile.battles} 场 · 胜利 ${profile.wins} 场`;$('coach-mode').value=profile.coach.mode;}
function grown(id){return createGame(17,[id,...SPECIES.filter(p=>p.id!==id).slice(0,2).map(p=>p.id)],{pets:profile.pets}).player.pets[0];}
// 营地 = 养成。只负责看伙伴和培养，出征相关的选择全部挪到出征页。
function camp(){
 wallet();$('record').textContent=`完成 ${profile.battles} 场 · 胜利 ${profile.wins} 场`;
 renderTypeFilter('camp-pages',()=>camp());
 $('camp-roster').innerHTML=filteredSpecies().map(base=>{const p=grown(base.id),order=selected.indexOf(p.id);
  return `<article class="pet-option ${order>=0?'chosen':''}">${order>=0?`<span class="order">${order+1}号位</span>`:''}<div class="pet-top"><span class="pet-icon">${p.icon}</span><div><h3>${p.name}</h3>${badge(p)} <span class="muted">Lv.${p.level}</span></div></div><p><strong>${p.bio}</strong> · ${p.trait}</p><div class="stats"><span>生命 ${p.maxHp}</span><span>攻击 ${p.atk}</span><span>防御 ${p.def}</span><span>速度 ${p.speed}</span></div><div class="buttons"><button data-focus="${p.id}" class="primary">培养</button>${order>=0?`<button data-pet="${p.id}">移出队伍</button>`:''}</div></article>`;}).join('');
 document.querySelectorAll('#camp-roster [data-focus]').forEach(b=>b.onclick=()=>{advanceContext();focus=b.dataset.focus;showCamp();cultivation();});
 document.querySelectorAll('#camp-roster [data-pet]').forEach(b=>b.onclick=()=>{const id=b.dataset.pet;selected=selected.filter(x=>x!==id);camp();});
 cultivation();
}
function filteredSpecies(){return SPECIES.filter(p=>rosterType==='all'||p.type===rosterType);}
function renderTypeFilter(navId,rerender){
 const filters=['all','fire','water','leaf','rock','electric','wind'];
 $(navId).innerHTML=filters.map(t=>{const n=t==='all'?SPECIES.length:SPECIES.filter(p=>p.type===t).length;return `<button data-roster-type="${t}" class="${rosterType===t?'selected':''}">${t==='all'?'全部':TYPES[t]} · ${n}</button>`;}).join('');
 document.querySelectorAll(`#${navId} [data-roster-type]`).forEach(b=>b.onclick=()=>{rosterType=b.dataset.rosterType;rerender();});
}
// 出征页 = 选关卡、选三只、选难度，然后开始。
function deployView(){
 wallet();$('deploy-record').textContent=`完成 ${profile.battles} 场 · 胜利 ${profile.wins} 场`;
 renderStages();renderTypeFilter('roster-pages',()=>deployView());
 $('roster').innerHTML=filteredSpecies().map(base=>{const p=grown(base.id),order=selected.indexOf(p.id);
  return `<article class="pet-option ${order>=0?'chosen':''}">${order>=0?`<span class="order">${order+1}号位</span>`:''}<div class="pet-top"><span class="pet-icon">${p.icon}</span><div><h3>${p.name}</h3>${badge(p)} <span class="muted">Lv.${p.level}</span></div></div><p><strong>${p.bio}</strong> · ${p.trait}</p><div class="stats"><span>生命 ${p.maxHp}</span><span>攻击 ${p.atk}</span><span>防御 ${p.def}</span><span>速度 ${p.speed}</span></div><div class="buttons"><button data-pet="${p.id}" ${preview||(order<0&&selected.length>=3)?'disabled':''}>${order>=0?'移出队伍':'加入队伍'}</button><button data-focus="${p.id}">培养</button></div></article>`;}).join('');
 $('selection').innerHTML=selected.length?selected.map((id,i)=>`<span class="slot"><em>${i+1}</em>${SPECIES.find(p=>p.id===id).name}</span>`).join(''):'<span class="muted">按 1 → 2 → 3 的出场顺序选择三只伙伴</span>';
 const advice=selected.length?rosterAdvice(selected.map(grown)):null;
 if(advice){const head=advice.lines[0]+' '+advice.lines[2];
  $('roster-advice').innerHTML=`<strong>✦ 阵容</strong><span>${escape(head)}</span><details><summary>全部结论</summary>${advice.lines.map(l=>'<p>'+escape(l)+'</p>').join('')}</details>`;}
 else $('roster-advice').innerHTML='<span class="muted">选好三只后给出阵容建议：共同弱点、克制面与速度线</span>';
 $('start').disabled=!!preview||selected.length!==3;
 document.querySelectorAll('#roster [data-pet]').forEach(b=>b.onclick=()=>{const id=b.dataset.pet;selected=selected.includes(id)?selected.filter(x=>x!==id):[...selected,id];deployView();});
 document.querySelectorAll('#roster [data-focus]').forEach(b=>b.onclick=()=>{advanceContext();focus=b.dataset.focus;showCamp();camp();});
 const pvp=matchMode==='pvp',stage=STAGES.find(x=>x.id===stageId),avg=selected.length?Math.round(selected.reduce((a,id)=>a+(profile.pets[id]?.level||1),0)/selected.length):1;
 $('deploy-side').innerHTML=`<div class="side-row"><span>模式</span><b>${pvp?'对局 · PVP':'训练 · PVE'}</b></div>`
  +`<div class="side-row"><span>${pvp?'对手':'关卡'}</span><b>${pvp?(pvpOpponent==='human'?'真人同机 · 分屏':'AI 模拟真人 · Lv.'+avg):(stage?stage.name:'—')}</b></div>`
  +`<div class="side-row"><span>难度</span><b>${DIFFICULTIES[$('difficulty').value].name}</b></div>`
  +`<div class="side-row"><span>队伍</span><b>${selected.length} / 3</b></div>`
  +`<p class="muted" style="margin-top:12px">${pvp?'对局不选关卡：对手从全部 12 只里自动配队，等级按你的队伍适配。':'训练按关卡挑战固定对手，胜利记录通关。'}</p>`;
 $('deploy-side').querySelectorAll; 
}
function showCamp(){$('deploy').hidden=true;$('camp-home').hidden=false;$('camp-tab').classList.add('selected');}
function showDeploy(mode){matchMode=mode||matchMode;$('camp-home').hidden=true;$('deploy').hidden=false;$('camp-tab').classList.remove('selected');$('match-mode')&&($('match-mode').value=matchMode);syncMode();deployView();}
function cultivation(){const p=grown(focus),v=profile.pets[focus],used=Object.values(v.points).reduce((a,b)=>a+b,0);$('cultivation').innerHTML=`<h3>${p.icon} ${p.name}<small>Lv.${v.level}</small></h3><p class="pet-trait">${p.bio} · ${p.trait}</p><div class="xp-track"><div style="width:${v.level===5?100:v.xp/(v.level*30)*100}%"></div></div><p class="muted xp-line">${v.level===5?'已满级':`经验 ${v.xp}/${v.level*ruleFacts().xpPerLevel} · 升级 生命+${ruleFacts().growth.level.hp} 攻防+${ruleFacts().growth.level.atk}`} · 培养格 ${used}/${trainingCapacity(v.level)}</p><div class="train-grid">${Object.entries(TRAINING).map(([key,t])=>`<div class="train-cell"><span class="train-name">${t.name}</span><span class="train-count">${v.points[key]}/${MAX_STAT_TRAINING}</span><small>${t.gain}</small><button data-train="${key}" ${preview||used>=trainingCapacity(v.level)||v.points[key]>=MAX_STAT_TRAINING||profile.tokens<1?'disabled':''}>＋1</button></div>`).join('')}</div><div id="loadout-editor"></div><button id="reset-training" ${used&&!preview?'':'disabled'}>重置 · 返还 ${used} 点</button><p class="hint">培养立即影响下次对战。本机自动保存。</p><button id="cultivation-coach">✦ 问小芽怎么培养</button><div id="growth-scene" hidden class="growth-scene"><strong>✦ 小芽 · 培养建议</strong><p>${SCENARIOS.find(x=>x.id==='growth').text}</p><button id="growth-dismiss">暂时收起</button></div>`;renderLoadout();
// 配招编辑器：从 6 个可学技能里选 4 个。用卡片而不是下拉框，
// 因为下拉框允许选成重复项，只能在保存时抛一个笼统错误。
function effectiveLoadout(){return [...grown(focus).skills];}
function renderLoadout(){
 const box=$('loadout-editor');if(!box)return;
 const p=grown(focus),held=profile.pets[focus].heldItem||p.heldItem||'none';
 const draft=loadoutDraft||effectiveLoadout(),full=draft.length>=4;
 // 默认折叠：只列出已选 4 个技能，避免整页被 6 张卡撑长。
 if(!loadoutOpen){
  const chips=draft.map(id=>{const s=SKILLS[id];return `<span>${s.name}${s.priority?` <i>先制+${s.priority}</i>`:''}</span>`;}).join('');
  box.innerHTML=`<div class="loadout"><div class="loadout-head"><strong>配招 · 6 选 4</strong><span class="muted">携带物 · ${held==='none'?'未装备':HELD_ITEMS[held].name}</span></div><div class="chosen-chips">${chips}</div><p class="loadout-note">改动只影响下一局。</p><button id="edit-loadout" class="wide">编辑配招</button></div>`;
  $('edit-loadout').onclick=()=>{loadoutOpen=true;renderLoadout();};
  return;
 }
 const cards=p.learnset.map(id=>{const s=SKILLS[id],on=draft.includes(id);
  return `<button type="button" class="skill-card${on?' on':''}" data-skill="${id}" aria-pressed="${on}" ${!on&&full?'disabled':''}><span class="skill-top"><strong>${s.name}</strong>${s.priority?`<em class="tag">先制 +${s.priority}</em>`:''}</span><span class="skill-meta">${s.power?`威力 ${s.power}`:'变化'} · ${s.cost} 豆</span><small>${s.desc}</small></button>`;}).join('');
 box.innerHTML=`<div class="loadout"><div class="loadout-head"><strong>配招 · 6 选 4</strong><span class="muted">已选 ${draft.length}/4</span></div><p class="loadout-note">选 4 个技能带入下一局，防御也占一个技能槽。</p><div class="skill-grid">${cards}</div><p class="skill-count">已选 <strong>${draft.length}</strong> / 4${draft.length<4?` · 还差 ${4-draft.length} 个`:''}</p><label class="held-row">携带物 <select id="held-item">${Object.entries(HELD_ITEMS).map(([k,x])=>`<option value="${k}" ${held===k?'selected':''}>${x.name}</option>`).join('')}</select></label><p class="loadout-note" id="held-desc">${HELD_ITEMS[held].desc}</p><div class="loadout-actions"><button id="save-loadout" ${draft.length!==4||preview?'disabled':''}>保存配招</button><button id="collapse-loadout">收起</button>${loadoutDraft?'<button id="cancel-loadout">放弃</button>':''}</div><p id="loadout-error" role="status"></p></div>`;
 document.querySelectorAll('[data-skill]').forEach(b=>b.onclick=()=>{const id=b.dataset.skill,cur=loadoutDraft||effectiveLoadout();loadoutDraft=cur.includes(id)?cur.filter(x=>x!==id):(cur.length>=4?cur:[...cur,id]);renderLoadout();});
 $('held-item').onchange=()=>{$('held-desc').textContent=HELD_ITEMS[$('held-item').value].desc;};
 $('save-loadout').onclick=()=>{try{profile=configurePet(profile,focus,loadoutDraft||effectiveLoadout(),$('held-item').value);advanceContext();loadoutDraft=null;loadoutOpen=false;save();camp();$('save-message').textContent='配招已保存，下次训练生效';}catch(error){$('loadout-error').textContent=error.message;}};
 $('collapse-loadout').onclick=()=>{loadoutOpen=false;renderLoadout();};
 const cancel=$('cancel-loadout');if(cancel)cancel.onclick=()=>{loadoutDraft=null;loadoutOpen=false;renderLoadout();};
}
document.querySelectorAll('[data-train]').forEach(b=>b.onclick=()=>{try{advanceContext();profile=train(profile,focus,b.dataset.train);save();camp();}catch(e){$('save-message').textContent=e.message;}});$('reset-training').onclick=()=>{advanceContext();profile=resetTraining(profile,focus);save();camp();};$('cultivation-coach').onclick=()=>{openCoach();ask('怎么培养');};$('growth-dismiss').onclick=()=>$('growth-scene').hidden=true;if(preview==='growth')$('growth-scene').hidden=false;renderGrowthCoach();}
function hp(p){return `<div class="hp-track"><div class="hp-fill ${p.hp/p.maxHp<.3?'low':''}" style="width:${p.hp/p.maxHp*100}%"></div></div>`;}
function sideView(state,side){const s=state[side],p=active(state,side);return `<div class="pet-active"><div class="pet-heading"><span class="pet-icon">${p.icon}</span><h3>${p.name}</h3>${badge(p)}<small>Lv.${p.level}</small></div><p class="stats">${p.bio} · 攻 ${p.atk} / 防 ${p.def} / 速 ${effectiveSpeed(p)}${p.speedDown?`（减速${p.speedDown.amount}）`:""}${Object.entries(p.buffs||{}).map(([stat,b])=>` · ${stat==='atk'?'攻击':'防御'}+${Math.round(ruleFacts().buff.perStack*b.stacks*100)}%/${b.remaining}回合`).join('')}${p.heldItem&&p.heldItem!=='none'?` · ${HELD_ITEMS[p.heldItem].name}${p.heldUsed?'（已触发）':''}`:''}</p><div class="hp-line"><span>${p.status?`${p.status.kind==='burn'?'灼烧':'中毒'} ${p.status.remaining} 回合`:'生命'}</span><strong>${p.hp} / ${p.maxHp}</strong></div>${hp(p)}<div class="energy">${'●'.repeat(p.energy)}${'○'.repeat(Math.max(0,ruleFacts().energy.max-p.energy))} <small>${p.energy}/${ruleFacts().energy.max} · 在场存活回合末 +${ruleFacts().energy.perTurn}</small></div></div><div class="bench">${s.pets.map((p,i)=>`<div class="bench-pet ${i===s.active?'current':''} ${p.hp<=0?'fainted':''}">${p.name}<div class="stats">${p.hp<=0?'已倒下':`${p.hp}HP · ${p.energy}能量`}${p.status?' · 异常':''}</div>${hp(p)}</div>`).join('')}</div><p class="inventory">回复药 ${s.items.potion} · 净化药 ${s.items.cleanse} · 能量果 ${s.items.ether}</p>`;}
const available=a=>!busy&&legalActions(game).some(b=>a.kind===b.kind&&a.id===b.id&&a.target===b.target);
function button(a,title,desc,extra=''){return `<button class="action" data-action='${JSON.stringify(a)}' ${available(a)?'':'disabled'}><div class="action-heading"><span>${title}</span>${extra?`<em>${extra}</em>`:''}</div><small>${desc}</small></button>`;}
function renderSides(state){$('player').innerHTML=sideView(state,'player');$('enemy').innerHTML=sideView(state,'enemy');}

// 本地对战一律允许教练：教练是玩家的助手，分屏时对方也有自己的那条教练，
// 所以不构成不公平。真正该守的底线是「不读取对方待执行动作」，那条一直没破。
// 只有线上竞技（pvp-live）才闭麦，由 coach/policy.js 决定。
function coachAllowedInMatch(){return true;}
function matchContext(message){const c=buildContext(game,profile,focus,roundArchive,stageId,message);c.coachAllowed=coachAllowedInMatch();return c;}

// 双方的行动面板用同一个渲染器，保证 UI 完全一致；只是数据取各自那一侧。
function actionPanelHtml(side,whichTab){
 const g=game,s=g[side],p=active(g,side),legal=legalActions(g,side);
 // 对手一侧固定由 AI 出招：面板保留（界面与真人对战一致）但明确只读。
 const ok=a=>(side==='player'||humanOpponent())&&!busy&&!g.result&&legal.some(b=>a.kind===b.kind&&a.id===b.id&&a.target===b.target);
 const btn=(a,title,desc,extra='')=>`<button class="action" data-side="${side}" data-action='${JSON.stringify(a)}' ${ok(a)?'':'disabled'}><div class="action-heading"><span>${escape(title)}</span>${extra?`<em>${escape(extra)}</em>`:''}</div><small>${escape(desc)}</small></button>`;
 if(whichTab==='skill')return p.skills.map(id=>{const sk=SKILLS[id];return btn({kind:'skill',id},sk.name,sk.desc,`${sk.power?'威力 '+sk.power+' · ':''}${sk.priority===1?'先制 · ':''}消耗 ${sk.cost} 豆`);}).join('');
 if(whichTab==='switch')return s.pets.map((q,target)=>btn({kind:'switch',target},q.name,`${TYPES[q.type]}系 · ${q.hp}/${q.maxHp} HP · ${q.energy} 能量`,target===s.active?'正在场上':q.hp<=0?'已倒下':g.phase==='replace'?'免费补位':'换宠占用整回合')).join('');
 if(whichTab==='item')return Object.entries(ITEMS).map(([id,item])=>`<div class="item-group"><p>${item.name} ×${s.items[id]}<br><span class="muted">${escape(item.desc)}</span></p><div class="targets">${s.pets.map((q,target)=>`<button data-side="${side}" data-action='${JSON.stringify({kind:'item',id,target})}' ${ok({kind:'item',id,target})?'':'disabled'}>${escape(q.name)}</button>`).join('')}</div></div>`).join('');
 // 认输只对本地玩家开放：对手认输会走另一条结算（引擎的 escape 语义属于我方撤退）。
 return `<div class="item-group"><p>撤退立即结束本场，不获得经验与训练点。</p><button data-side="${side}" data-action='{"kind":"escape"}' ${side==='player'&&ok({kind:'escape'})?'':'disabled'}>确认撤退</button></div>`;
}
function render(){$('round-coach').textContent=game.result?'✦ 整局复盘':'✦ 回合回顾';renderSides(game);$('environment-info').textContent=game.environment?`${game.environment.name} · 剩${game.environment.turns}回合：${game.environment.desc}`:'无场地环境';$('enemy-difficulty').textContent=game.mode==='pvp-local'?('本地对战 · 对手 Lv.'+game.enemy.pets[0].level):DIFFICULTIES[game.difficulty]?.name+(game.stageName?' · '+game.stageName:' · 预制场景');const roundLabel=game.phase==='replace'?'免费补位':`第 ${Math.min(game.turn,ruleFacts().turnLimit)} 回合`;
if($('turn').textContent!==roundLabel){$('turn').textContent=roundLabel;$('turn').classList.remove('round-pulse');void $('turn').offsetWidth;$('turn').classList.add('round-pulse');} $('phase').textContent=busy?'正在出招…':game.result?'本场结束':game.phase==='replace'?'请选择补位伙伴':'等待行动';$('restart').disabled=busy;$('camp-tab').disabled=busy;$('preview-exit').disabled=busy;$('preview-again').disabled=busy;$('export').disabled=busy;
$('result').hidden=!game.result;if(game.result)$('result').innerHTML=`<strong>${{win:'训练胜利',loss:'本场失利',draw:'本场平局',escaped:'已撤退'}[game.result]}</strong>${reward?`全队经验 +${reward.xp} · 训练点 +${reward.tokens}${reward.swift?' · 首次'+ruleFacts().swiftTurnLimit+'回合内速胜 +1点（已计入）':''}${reward.levels.length?' · '+reward.levels.join('，'):''}`:game.preview?'预制体验，不计入成长':'本场无成长奖励'} · ${game.preview?'退出体验可恢复原对战':'返回营地继续培养'}`;
const forceSwitch=game.phase==='replace';
 if(forceSwitch){tab='switch';enemyTab='switch';}
 document.querySelectorAll('[data-tab]').forEach(b=>{const side=b.dataset.side||'player',mine=side==='enemy'?enemyTab:tab;
  b.classList.toggle('selected',b.dataset.tab===mine);
  b.disabled=busy||!!game.result||(forceSwitch&&b.dataset.tab!=='switch')||(side==='enemy'&&!splitMode());});
if(game.result)$('actions').innerHTML=`<p class="muted">${game.preview?'预制场景结束，不影响正式成长。':'本场结束，成长已自动保存。返回营地可培养或重新组队。'}</p>`;
else $('actions').innerHTML=actionPanelHtml('player',tab);
if(splitMode()&&!game.result)$('enemy-actions').innerHTML=actionPanelHtml('enemy',enemyTab);
$('log').replaceChildren(...reverseRounds(game.log).map(line=>{const p=document.createElement('p');p.textContent=line;if(line.startsWith('──'))p.className='round';return p;}));$('log').scrollTop=0;document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>{const a=JSON.parse(b.dataset.action),side=b.dataset.side||'player';if(splitMode())pvpPick(side,a);else act(a);});renderSplitPanels();}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// ---------- 本地对战：分屏同屏，双方各选一招后一起结算 ----------
const pvpMode=()=>game?.mode==='pvp-local';
const splitMode=()=>pvpMode();
const humanOpponent=()=>splitMode()&&pvpOpponent==='human';
let pvpPicks={player:null,enemy:null};
function actionLabel(a,side){
 const g=game;
 if(a.kind==='skill')return a.id==='guard'?'防御':(SKILLS[a.id]?.name||a.id);
 if(a.kind==='switch')return '换上 '+g[side].pets[a.target].name;
 if(a.kind==='item')return (ITEMS[a.id]?.name||a.id)+' → '+g[side].pets[a.target].name;
 if(a.kind==='escape')return '认输';
 return a.kind;
}
function actionDetail(a){
 if(a.kind==='skill'){const sk=SKILLS[a.id];return (sk.power?`威力 ${sk.power} · `:'')+(sk.priority?'先制 · ':'')+`消耗 ${sk.cost} 豆`;}
 if(a.kind==='switch')return '换宠占用整回合';
 if(a.kind==='item')return ITEMS[a.id]?.desc||'';
 if(a.kind==='escape')return '立即结束本场';
 return '';
}
// 双方各自的面板：选完只显示"已锁定"，两边都锁定才亮牌并结算，
// 这样同屏也不会让后手看到先手选了什么。
function renderSplitPanels(){
 const split=splitMode();
 $('panel-enemy').hidden=!split;
 $('bottom-grid').classList.toggle('versus',split);
 if(!split)return;
 const replacing=game.phase==='replace';
 const rs=replacing?(game.replaceSide||'player'):null;
 $('enemy-side-note').textContent=humanOpponent()?(replacing&&rs!=='enemy'?'等待对方补位':(pvpPicks.enemy?'已锁定':'对手选择行动')):(replacing?(rs==='enemy'?'轮到你补位':'对手正在补位'):'已独立出招（看不到你的选择）');
 const locked=!!pvpPicks.enemy||busy||!!game.result||(replacing&&rs!=='enemy');
 if(locked)document.querySelectorAll('#enemy-actions [data-action]').forEach(b=>b.disabled=true);
 const mineLocked=!!pvpPicks.player||busy||!!game.result||(replacing&&rs!=='player');
 if(mineLocked)document.querySelectorAll('#actions [data-action]').forEach(b=>b.disabled=true);
 $('message').textContent=pvpPicks.player?'已锁定，等对方选择…':'';
}
// 每回合先让对手独立做决定（只看回合前的公开局面），然后才轮到我选。
// 决定的时刻早于我的选择，所以它不可能参考我的行动——这就是隔离。
function decideEnemyFirst(){if(humanOpponent()){pvpEnemyLocked=null;return;}pvpEnemyLocked=game&&!game.result?chooseEnemy(game):null;pvpEnemyRevealed=false;}
function pvpPick(side,a){
 if(busy||game.result||pvpPicks[side])return;
 if(side==='enemy'&&!humanOpponent())return;                 // AI 出招时玩家不能替它选
 if(game.phase==='replace'){if((game.replaceSide||'player')!==side)return;act(a);return;}
 pvpPicks[side]=a;pvpEnemyRevealed=true;
 const theirs=humanOpponent()?pvpPicks.enemy:pvpEnemyLocked;
 if(pvpPicks.player&&theirs){const mine=pvpPicks.player;pvpOpponent=$('pvp-opponent').value;tab='skill';enemyTab='skill';faintShown=false;resultAnnounced=false;pvpPicks={player:null,enemy:null};pvpEnemyLocked=null;pvpEnemyRevealed=false;act(mine,theirs);return;}
 renderSplitPanels();
}

// 双方各一条教练条：同一套引擎、同一套规则，各自只分析自己那一侧。
// 对面用镜像上下文（player/enemy 对调），所以它看到的是"对方的局面"，
// 不会读到任何隐藏信息（待执行动作本来就不在上下文里）。
function swappedContext(ctx){
 const b=ctx?.battle;if(!b)return ctx;
 const {player,enemy,...rest}=b;
 return {...ctx,battle:{...rest,player:enemy,enemy:player}};
}
function updateSideCoaches(){
 if(!pvpMode()||!game||game.result){$('player-coach').hidden=true;$('enemy-coach').hidden=true;return;}
 for(const [side,box,text] of [['player','player-coach','player-coach-text'],['enemy','enemy-coach','enemy-coach-text']]){
  try{
   const base=matchContext('这回合怎么打');
   const ctx=side==='enemy'?swappedContext(base):base;
   const packet=strategist({...ctx,query:'这回合怎么打'});
   const copy=(packet&&packet.text)?packet.text:'这一回合没有明显更优的选择：先比较对方留场和换宠两种分支。';
   $(text).textContent=concise(copy,120);$(box).hidden=false;
  }catch{$(box).hidden=true;}
 }
}

async function act(action,enemyAction){if(busy)return;
 cancelVoice();advanceContext();hintEpoch++;busy=true;clearTimeout(nudgeTimer);$('attention-cue').hidden=true;$('live-coach').hidden=true;const old=game;const shown=(coachMemory.journal||[]).some(e=>e.matchId===matchId&&e.turn===old.turn&&e.kind==='hint');const decision={...assessDecision(old,action,rankEnemyActions({...old,player:old.enemy,enemy:old.player})),caseKey:active(old,'player').id+':'+active(old,'enemy').id};render();$('action-banner').textContent='双方正在选择并结算行动…';try{await pause(20);const next=pvpMode()?resolveTurn(old,action,enemyAction!==undefined?enemyAction:chooseEnemy(old),{manualReplace:true}):step(old,action);let previous=old;const ms=matchMedia('(prefers-reduced-motion: reduce)').matches?0:Number($('speed').value);
for(const frame of next.frames||[]){if(!frame.text)continue;renderSides(frame.state);$('action-banner').textContent=frame.text;for(const side of ['player','enemy']){const card=$(side+'-card'),floating=$(side+'-float'),p=active(frame.state,side),prev=previous[side].pets.find(x=>x.id===p.id),delta=p.hp-prev.hp;card.classList.remove('hit','act','guarding');floating.className='float-number';void card.offsetWidth;if(delta<0)card.classList.add('hit');else if(frame.side===side)card.classList.add('act');if(frame.text.includes('防御：')&&frame.side===side)card.classList.add('guarding');if(delta){floating.textContent=(delta>0?'+':'')+delta;floating.className='float-number show'+(delta>0?' heal':'');}}previous=frame.state;if(ms)await pause(ms);}
game=next;
 // 陪练的主动气泡只挂在两个真实事件上：本局第一次有伙伴倒下，以及整局结束。
 // 其余一切（连招、血量变化、普通回合）都不开口——门控与措辞在 coachEvent 里，
 // 这里只负责在正确的时刻把事件交出去。
 if(!preview)for(const ev of companionEvents(game,{faintShown,resultAnnounced})){
  if(ev==='first-faint')faintShown=true;else resultAnnounced=true;
  notify(ev);
 }
 if(decision&&!preview){coachMemory=rememberDecision(coachMemory,{matchId,turn:old.turn,...decision,prompted:shown,rulesVersion:old.version});saveCoachMemory();}lastFeedback=pvpMode()?null:feedback(game.history.filter(x=>x.type==='turn').at(-1),currentHint);if(!preview){roundArchive=archiveRound(game,roundArchive);try{localStorage.setItem('xiaoya-last-round',JSON.stringify(roundArchive));}catch{$('save-message').textContent='对局记录保存失败，先导出战报以免刷新丢失。';}}if(old.phase==='replace')tab='skill';if(game.result){const settled=settle(profile,game,matchId);profile=settled.profile;reward=settled.reward;if(!game.preview){save();coachMemory=rememberBattle(coachMemory,game);saveCoachMemory();}/* Completion review is rendered after settlement, without a second generic bubble. */}else if(!faintShown&&game.player.pets.some(p=>p.hp<=0)){faintShown=true;}
$('action-banner').textContent=game.result?'本场已结束。成长奖励见上方。':game.phase==='replace'?'伙伴倒下了，请选择下一只出场，补位不消耗回合。':`${next.frames?.filter(f=>f.text).at(-1)?.text||'补位完成。'} 下一回合由你决定。`;
}catch(e){game=old;$('message').textContent=e.message;$('action-banner').textContent='行动未完成，请重试。';}finally{busy=false;for(const side of ['player','enemy'])$(side+'-card').classList.remove('hit','act','guarding');render();trackAttention(attention,game.turn+':'+game.phase,null,Date.now());hoverAction=null;pvpPicks={player:null,enemy:null};if(splitMode())decideEnemyFirst();renderSplitPanels();updateSideCoaches();updateCoach();}}
function notify(event){if(preview)return;const text=coachEvent(event,coachContext(game,profile),coachSession);if(text){$('bubble-text').textContent=text;$('coach-bubble').hidden=false;clearTimeout(bubbleTimer);bubbleTimer=setTimeout(()=>$('coach-bubble').hidden=true,9000);}}
function openCoach(){connectionStatus().then(s=>{$('coach-status').textContent=s.configured?(s.verified?'DeepSeek 已连接':'DeepSeek 已配置，尚未验证'):'本地模式 · 未配置密钥';}).catch(()=>{$('coach-status').textContent='后端未启动，请运行 npm start';});$('coach-panel').hidden=false;$('coach-bubble').hidden=true;}
function addChat(role,text){conversation.push({role:role==='你'?'user':'assistant',content:text});conversation=conversation.slice(-8);const e=document.createElement('div');e.className='chat-entry'+(role==='你'?' user':'');e.innerHTML=`<strong>${role}</strong>${markdown(text)}`;$('chat-log').append(e);$('chat-log').scrollTop=$('chat-log').scrollHeight;}
// 等待指示：请求发出后立刻出现，收到回答或失败时移除。
function showThinking(label){hideThinking();const e=document.createElement('div');e.className='chat-entry thinking';e.id='chat-thinking';e.innerHTML=`<strong>小芽</strong><span class="thinking-text">${escape(label)}</span><span class="dots"><i></i><i></i><i></i></span>`;$('chat-log').append(e);$('chat-log').scrollTop=$('chat-log').scrollHeight;}
function hideThinking(){document.getElementById('chat-thinking')?.remove();}
async function ask(text){
 if(!text.trim()||asking)return;if(busy){$('coach-status').textContent='请等本回合出招结束，再分析当前战况';return;}asking=true;addChat('你',text);$('coach-status').textContent='正在读取游戏状态…';const remote=!['policy'].includes(coachRole);showThinking('正在读取局面与依据…');$('chat-send').disabled=true;$('chat-input').disabled=true;
 const epoch=contextEpoch,stamp=taskStamp({epoch,matchId:game?.id||null,rulesVersion:game?.version||'0.6'});
 try{const answer=await requestCoach({message:text,role:coachRole,context:matchContext(text),memory:coachMemory,conversation:conversation.slice(0,-1),stateToken:epoch});if(!taskIsCurrent(stamp,{epoch:contextEpoch,matchId:game?.id||null,rulesVersion:game?.version||'0.6'})||answer.stateToken!==epoch){hideThinking();$('coach-status').textContent='局面已变化或建议已过期，本次旧建议已丢弃，请重新提问';return;}coachMemory=answer.memory;if(answer.fallbackReason&&game)coachMemory=recordCoachEvent(coachMemory,{id:matchId+':'+game.turn+':fallback:'+Date.now(),kind:'coach-fallback',reason:answer.fallbackReason,matchId,turn:game.turn,rulesVersion:game.version});saveCoachMemory();if(!game)cultivation();addChat('小芽',answer.text);
 const entry=$('chat-log').lastElementChild;if(answer.choices){const controls=document.createElement('div');controls.className='quiz-choices';for(const choice of answer.choices){const b=document.createElement('button');b.textContent=choice;b.onclick=()=>{controls.remove();ask(choice);};controls.append(b);}entry.append(controls);}
 if(answer.evidence.length){const details=document.createElement('details');details.className='coach-evidence';details.innerHTML='<summary>依据 · '+escape({strategist:'军师',teacher:'老师',companion:'陪练',auto:'偏好',policy:'场景限制',guide:'游戏说明'}[answer.route]||answer.route)+'</summary>'+answer.evidence.map(x=>'<p>'+escape(x)+'</p>').join('');entry.append(details);}
 if(answer.toolTrace?.length){const details=document.createElement('details');const summary=document.createElement('summary');summary.textContent='小芽查了什么';details.append(summary);const names={read_state:'当前局面',search_rules:'规则和战术',compare_actions:'行动分支',inspect_training:'培养面板',read_last_turn:'上一回合记录',read_match:'整局记录',read_evidence:'指定回合原始证据',simulate_branch:'假设行动分支'};for(const receipt of answer.toolTrace){const line=document.createElement('p');line.textContent=names[receipt.tool]||receipt.tool;details.append(line);}entry.append(details);}
 $('coach-status').textContent=answer.fallbackReason?answer.fallbackReason:answer.provider==='deepseek'?'DeepSeek 已回答 · 依据可展开查看':answer.verified?(answer.scope==='match'?'整局记录已读取 · 可展开关键回合':answer.memory.lastTopic==='review'?'原始回合已读取 · 计算条件可核对':'本地规则核验 · 不经模型自由改写'):'本地教练 · 依据可展开查看';
 }catch(e){hideThinking();if(e.name==='AbortError'){if(epoch===contextEpoch)$('coach-status').textContent='这条请求已取消';return;}addChat('小芽','这次没有完成分析，请重试。');$('coach-status').textContent=e.message;}finally{hideThinking();asking=false;$('chat-send').disabled=false;$('chat-input').disabled=false;}
}
function startMatch(){advanceContext();const seed=Number($('seed').value);if(!Number.isInteger(seed)||seed<0||seed>4294967295){$('save-message').textContent='种子需为 0～4294967295 的整数';return;}pvpOpponent=$('pvp-opponent').value;pvpPicks={player:null,enemy:null};pvpEnemyLocked=null;pvpEnemyRevealed=false;const versus=matchMode==='pvp';const avgLv=selected.reduce((a,id)=>a+(profile.pets[id]?.level||1),0)/Math.max(1,selected.length);
game=createGame(seed,selected,versus?{pets:profile.pets,difficulty:$('difficulty').value,mode:'pvp-local',...buildVersusOpponent(seed,{level:avgLv})}:{pets:profile.pets,difficulty:$('difficulty').value,mode:'pve',...stageOptions(stageId)});$('mode-badge').textContent=(matchMode==='pvp'?'对局 · PVP · v0.11':'训练 · PVE · v0.11');matchId=crypto.randomUUID();game.id=matchId;coachMemory.watches=[];saveCoachMemory();tacticalShown=new Set();tacticalCount=0;lastTacticalTurn=-10;reward=null;tab='skill';faintShown=false;attention=attentionState(Date.now());coachSession={count:0,lastTurn:null,dismissed:false};$('coach-bubble').hidden=true;$('camp-home').hidden=true;$('deploy').hidden=true;$('battle').hidden=false;$('camp-tab').classList.remove('selected');$('message').textContent='';$('action-banner').textContent=matchMode==='pvp'?('本地对战：对手由 AI 扮演一位真人——自动配队、独立出招，界面与真人对战一致。双方各选一招后同时结算。'):'选择行动。电脑会根据回合前局面决策，不读取你的待执行选择。';render();autoCalls=0;lastAutoReason=null;visibleHintReason=null;visibleHintTurn=-10;coachMuted=false;lastFeedback=null;decideEnemyFirst();updateSideCoaches();updateCoach();}
$('start').onclick=()=>startMatch();
function toCamp(){if(busy)return;$('mode-badge').textContent=matchMode==='pvp'?'对局 · PVP · v0.11':'训练 · PVE · v0.11';pvpPicks={player:null,enemy:null};$('panel-enemy').hidden=true;$('bottom-grid').classList.remove('versus');cancelVoice();advanceContext();if(preview){exitPreview();return;}if(game&&!game.result&&!confirm('离开会结束本次训练且没有奖励，返回营地吗？'))return;hintEpoch++;currentHint=null;$('attention-cue').hidden=true;clearTimeout(nudgeTimer);game=null;$('battle').hidden=true;$('coach-bubble').hidden=true;$('camp-tab').classList.add('selected');$('deploy').hidden=true;$('camp-home').hidden=false;camp();}
function syncMode(){
 const pvp=matchMode==='pvp';
 $('stage-step').hidden=pvp;$('stage-picker').hidden=pvp;$('stage-detail').hidden=pvp;
 const row=$('opponent-row');if(row)row.hidden=!pvp;
 if(!pvp)pvpOpponent='ai';
 $('start').textContent=pvp?'开始对战':'开始训练';
 $('mode-badge').textContent=pvp?'对局 · PVP · v0.11':'训练 · PVE · v0.11';
 if($('deploy-mode'))$('deploy-mode').textContent=pvp?'对局 · PVP':'训练 · PVE';
 $('mode-note').textContent=pvp?(pvpOpponent==='human'?'对局 · 真人同机：分屏同屏，两侧面板都可操作，各自选招后一起结算；双方各有一条教练。':'对局 · AI 模拟真人：对手从全部 12 只里自动配队并适配你的等级，先独立出招再看不到你的选择；界面与真人对战一致。')
  :'训练 · PVE：按关卡挑战固定对手，教练会主动提示，也可随时提问。';
}
$('pvp-opponent').onchange=()=>{pvpOpponent=$('pvp-opponent').value;syncMode();if(!$('deploy').hidden)deployView();};
$('difficulty').onchange=()=>{if(!$('deploy').hidden)deployView();};
syncMode();
$('restart').onclick=toCamp;$('camp-tab').onclick=()=>{if(game&&!game.result){toCamp();return;}showCamp();};$('go-pve').onclick=()=>showDeploy('pve');$('go-pvp').onclick=()=>showDeploy('pvp');$('rules-toggle').onclick=()=>$('rules').showModal();
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{if((b.dataset.side||'player')==='enemy')enemyTab=b.dataset.tab;else tab=b.dataset.tab;render();});
$('export').onclick=()=>{const blob=new Blob([JSON.stringify(game,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`pet-battle-${game.initialSeed}-turn-${game.turn}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$('coach-open').onclick=openCoach;$('coach-close').onclick=()=>$('coach-panel').hidden=true;$('bubble-chat').onclick=()=>{openCoach();addChat('小芽',$('bubble-text').textContent);};$('bubble-close').onclick=()=>{coachSession.dismissed=true;attention.dismissed=true;coachMuted=true;hintEpoch++;$('live-coach').hidden=true;$('attention-cue').hidden=true;$('coach-bubble').hidden=true;};$('coach-mode').onchange=()=>{cancelVoice();profile.coach.mode=$('coach-mode').value;advanceContext();hintEpoch++;$('attention-cue').hidden=true;attention.since=Date.now();if(profile.coach.mode==='quiet')$('coach-bubble').hidden=true;save();if(game)updateCoach();else cultivation();};
$('chat-form').onsubmit=e=>{e.preventDefault();ask($('chat-input').value);$('chat-input').value='';};document.querySelectorAll('[data-question]').forEach(b=>b.onclick=()=>ask(b.dataset.question));

// P05：难度名称与说明、规则弹窗正文都从规则数据源生成，界面不再手写数值。
function renderRules(){const el=$('rules-body');if(!el)return;el.innerHTML=rulesSections().map(section=>`<section><h3>${escape(section.title)}</h3>${section.lines.map(line=>`<p>${escape(line)}</p>`).join('')}</section>`).join('');}
$('difficulty').innerHTML=Object.entries(DIFFICULTIES).map(([id,d])=>`<option value="${id}"${id==='normal'?' selected':''}>${escape(d.name)}</option>`).join('');
$('difficulty').onchange=()=>{$('difficulty-help').textContent=DIFFICULTIES[$('difficulty').value].description;if(!$('deploy').hidden)deployView();};
$('difficulty-help').textContent=DIFFICULTIES[$('difficulty').value].description;renderRules();
if(coachMemory.dialogue?.length){for(const item of coachMemory.dialogue)addChat(item.role==='user'?'你':'小芽',item.content);}else addChat('小芽','我是小芽。你先玩，有需要我会简短提醒。想问规则、培养或复盘，也可以直接说。');camp();

function renderStages(){
 $('stage-picker').innerHTML=STAGES.map(stage=>`<button data-stage="${stage.id}" class="${stage.id===stageId?'selected':''}" ${preview?'disabled':''}><strong>${stage.name}</strong><small>Lv.${stage.level} ${(profile.clearedStages||[]).includes(stage.id)?'· 已通关':''}</small></button>`).join('');
 const stage=STAGES.find(x=>x.id===stageId);
 $('stage-detail').innerHTML=`<p class="stage-desc">${escape(stage.description)}</p><p class="stage-enemy"><span class="muted">对手阵容</span>${stage.team.map(id=>{const pet=SPECIES.find(p=>p.id===id),build=stage.pets[id];return `<span class="enemy-chip">${pet.icon} ${pet.name} <em>Lv.${build.level}</em><small>耐${build.points.hp}/力${build.points.atk}/敏${build.points.speed}</small></span>`;}).join('')}</p><p class="stage-reward muted">首次 ${ruleFacts().swiftTurnLimit} 回合内获胜额外 1 训练点 · 慢打基础奖励不减</p>`;
 document.querySelectorAll('[data-stage]').forEach(b=>b.onclick=()=>{advanceContext();stageId=b.dataset.stage;renderStages();cultivation();});
}
function clearScene(){clearTimeout(bubbleTimer);$('coach-bubble').hidden=true;$('scene-inline').hidden=true;$('scene-result').hidden=true;$('coach-panel').hidden=true;if($('growth-scene'))$('growth-scene').hidden=true;}
function presentScene(){
 clearScene();const scene=SCENARIOS.find(x=>x.id===preview);if(!scene)return;
 if(scene.placement==='inline'){$('scene-inline').hidden=false;$('inline-copy').hidden=true;$('inline-copy').textContent=scene.text;$('inline-expand').hidden=false;}
 if(scene.placement==='bubble'){$('bubble-text').textContent=scene.text;$('coach-bubble').hidden=false;bubbleTimer=setTimeout(()=>$('coach-bubble').hidden=true,9000);}
 if(scene.placement==='result'){$('scene-result').hidden=false;$('scene-result-text').textContent=scene.text;}
 if(scene.placement==='growth')$('growth-scene').hidden=false;
}
function startPreview(id){
 if(busy)return;advanceContext();
 hintEpoch++;$('live-coach').hidden=true;if(!preview)suspended={game,matchId,reward,tab,coachSession,faintShown,focus,coachMemory:structuredClone(coachMemory),conversation:structuredClone(conversation)};
 preview=id;game=createScenario(id);matchId='preview';reward=null;tab='skill';coachSession={count:0,lastTurn:null,dismissed:false};
 $('scenes-dialog').close();$('preview-bar').hidden=false;$('preview-title').textContent='预制体验 · '+SCENARIOS.find(x=>x.id===id).title+' · 不保存进度';
 $('camp-home').hidden=id!=='growth';$('deploy').hidden=id!=='growth';$('battle').hidden=id==='growth';
 if(id==='growth')camp();else render();
 $('action-banner').textContent='预制对战可以继续操作，退出后恢复原来的对战。';presentScene();
}
function exitPreview(){
 if(busy||!preview)return;advanceContext();clearScene();preview=null;
 ({game,matchId,reward,tab,coachSession,faintShown,focus,coachMemory,conversation}=suspended);suspended=null;$('preview-bar').hidden=true;
 $('camp-home').hidden=!!game;$('deploy').hidden=!!game;$('battle').hidden=!game;
 if(game){render();updateCoach();$('action-banner').textContent='已恢复体验前的对战。';}else camp();
}
$('scene-options').innerHTML=SCENARIOS.map(scene=>`<button data-scene="${scene.id}"><strong>${scene.title}</strong><span>${scene.description}</span></button>`).join('');
 document.querySelectorAll('[data-scene]').forEach(b=>b.onclick=()=>startPreview(b.dataset.scene));
$('preview-exit').onclick=exitPreview;$('preview-again').onclick=presentScene;
$('inline-expand').onclick=()=>{$('inline-copy').hidden=false;$('inline-expand').hidden=true;};$('inline-dismiss').onclick=()=>$('scene-inline').hidden=true;
$('scene-rest').onclick=exitPreview;$('scene-retry').onclick=()=>startPreview('risk');

document.querySelectorAll('[data-role]').forEach(b=>b.onclick=()=>{advanceContext();coachRole=b.dataset.role;document.querySelectorAll('[data-role]').forEach(x=>x.classList.toggle('selected',x===b));});
$('show-memory').onclick=()=>{addChat('小芽',memorySummary(coachMemory)+'\n'+`交流偏好：${coachMemory.preference==='brief'?'简短':coachMemory.preference==='detailed'?'详细':'未设置'}。记住 ${coachMemory.events.length} 场对战、${coachMemory.lessons.length} 条答对过的练习记录（不等于熟练掌握）。`);const details=document.createElement('details');const title=document.createElement('summary');title.textContent='查看最近的行为依据';details.append(title);for(const event of (coachMemory.journal||[]).slice(-8).reverse()){const row=document.createElement('p');row.textContent=`第${event.turn}回合 · ${{hint:'显示提示',dismiss:'主动关闭',decision:event.prompted?'提示后的行动':'独立行动'}[event.kind]||event.kind} · ${event.time.slice(0,10)}`;const remove=document.createElement('button');remove.textContent='删除这条';remove.onclick=()=>{advanceContext();coachMemory=deleteMemoryEvidence(coachMemory,event.id);conversation=[];$('chat-log').replaceChildren();saveCoachMemory();addChat('小芽','已删除这条记录和引用它的习惯判断，也清掉了可能含旧摘要的会话。游戏成长保留。');};row.append(remove);details.append(row);}$('chat-log').lastElementChild.append(details);};
$('clear-memory').onclick=()=>{advanceContext();conversation=[];$('chat-log').replaceChildren();coachMemory=freshMemory();roundArchive=null;try{localStorage.removeItem('xiaoya-last-round');}catch{}saveCoachMemory();addChat('小芽','已清除小芽的偏好、对战记忆和学习记录，游戏成长保持不变。');};

let reviewedMatch=null,reviewAnswer=null;
function showMatchReview(){
 const box=$('live-coach'),context=matchContext('复盘本局'),packet=reviewMatch(context),quiet=profile.coach.mode==='quiet';
 box.hidden=false;box.innerHTML='<div class="coach-whisper"><span class="whisper-icon">✦ 小芽 · 本局回顾</span><span id="result-copy">'+escape(quiet?'本局分析已备好，需要时展开。':concise(packet.brief||packet.text,110))+'</span><button id="result-review">整局分析</button></div><details><summary>关键回合与依据</summary>'+packet.evidence.map(x=>'<p>'+escape(x)+'</p>').join('')+'</details><small id="result-provider">本局记录分析</small>';
 $('result-review').onclick=()=>{openCoach();ask('总结整局：这局发生了什么，有什么值得记住的选择？');};
 if(reviewAnswer?.id===game.id&&!quiet){$('result-copy').textContent=concise(reviewAnswer.text,100);$('result-provider').textContent=reviewAnswer.source;}
 if(reviewedMatch===game.id||quiet||preview)return;reviewedMatch=game.id;
 const epoch=contextEpoch,id=game.id;let entry=null,historyEntry=null;
 if(!$('coach-panel').hidden){addChat('小芽',packet.brief||packet.text);entry=$('chat-log').lastElementChild;historyEntry=conversation.at(-1);}
 connectionStatus().then(status=>{if(!status.configured||contextEpoch!==epoch)return null;$('result-provider').textContent='正在结合整局记录分析…';return requestCoach({message:MATCH_REVIEW_REQUEST,role:'teacher',context,memory:coachMemory,conversation:[],cache:true,stateToken:epoch});}).then(answer=>{if(!answer||epoch!==contextEpoch||game?.id!==id||!$('result-copy'))return;$('result-copy').textContent=concise(answer.text,100);speakCue(answer.text);$('result-provider').textContent=answer.provider==='deepseek'?'DeepSeek · 根据本局记录分析':answer.fallbackReason||'本局规则分析';reviewAnswer={id,text:answer.text,source:$('result-provider').textContent};if(historyEntry&&conversation.includes(historyEntry)){historyEntry.content=answer.text;}else{conversation.push({role:'assistant',content:'本局自动总结：'+answer.text});conversation=conversation.slice(-8);}if(entry&&entry.isConnected){entry.innerHTML='<strong>小芽</strong>'+markdown(answer.text);}}).catch(()=>{if(epoch===contextEpoch&&$('result-provider'))$('result-provider').textContent='模型暂不可用 · 已保留本局分析';});
}
function updateCoach(force=false){
 if(game?.result&&!preview){showMatchReview();return;}
 // 真人同机对局进行中：教练不介入。两位玩家共用一块屏幕，任何一方拿到战术提示
 // 都是不公平的。对电脑时没有第三方，教练照常工作（coachAllowedInMatch）。
 if(pvpMode()&&game&&!game.result&&!coachAllowedInMatch()){for(const id of ['live-coach','attention-cue','coach-bubble','scene-inline','scene-result'])$(id).hidden=true;return;}
 const box=$('live-coach');const token=++hintEpoch;
 box.hidden=!!preview||!game||(!force&&profile.coach.mode==='quiet')||!coachAllowedInMatch();if(box.hidden)return;
 if(showTacticalCue()){box.hidden=true;return;}
 currentHint=observe(game);const hint=currentHint;
 const significant=hint&&(hint.turn===1||profile.coach.mode==='mentor'&&hint.turn-visibleHintTurn>=3||hint.reason!=='回合结束，重新评估局面'&&hint.reason!==visibleHintReason&&hint.turn-visibleHintTurn>=2);
 const critical=currentHint&&['伙伴倒下，需要补位','当前处于属性劣势'].includes(currentHint.reason);
 const shouldShow=force||!coachMuted&&(profile.coach.mode==='critical'?critical:significant||game.result);
 box.hidden=!shouldShow;
 if(!shouldShow)return;
 if(!force&&!adaptiveGate(coachMemory,{lesson:hint?.lesson||'行动取舍',risk:critical,mode:profile.coach.mode}).allow){box.hidden=true;return;}
 logCoachEvent('hint','inline');
 if(hint){visibleHintReason=hint.reason;visibleHintTurn=hint.turn;}
 box.innerHTML='<div class="coach-whisper"><span class="whisper-icon">✦ 小芽</span><span id="live-copy">'+escape(hint?hint.title+'。'+(hint.reason==='开场对位分析'?'先按这个打，出招后我按新局面重算。':hint.reason+'。'):'本场已结束。下面有一个值得回看的关键回合。')+'</span><button id="live-expand" aria-expanded="false">看看原因</button><button id="live-dismiss" aria-label="收起这条提示">×</button></div><div id="live-detail" hidden>'+
 '<small id="live-provider">规则分析 · 即时</small>'+
 (hint?'<p>'+escape(hint.text)+'</p><details><summary>计算依据</summary>'+hint.evidence.map(x=>'<p>'+escape(x)+'</p>').join('')+'<p>只比较一回合，不读取电脑待执行行动。</p></details>':'')+
 (lastFeedback?'<details><summary>上一回合反馈</summary><p>'+escape(concise(lastFeedback.text,180))+'</p></details><div class="coach-detail-actions"><button id="live-review">深入复盘</button> <button id="live-quiz">练一个知识点</button></div>':'<p class="muted">由你决定行动，出招后的事实记录会保留。</p>')+'</div>';
 $('live-expand').onclick=()=>{const open=$('live-detail').hidden;$('live-detail').hidden=!open;$('live-expand').textContent=open?'收起':'看看原因';$('live-expand').setAttribute('aria-expanded',String(open));};
 $('live-dismiss').onclick=()=>{cancelVoice();logCoachEvent('dismiss','inline');box.hidden=true;hintEpoch++;attention.dismissed=true;coachMuted=true;coachSession.dismissed=true;};
 if(force){$('live-detail').hidden=false;$('live-expand').textContent='收起';$('live-expand').setAttribute('aria-expanded','true');}
 if($('live-review'))$('live-review').onclick=()=>{openCoach();ask('回顾上一回合');};
 if($('live-quiz'))$('live-quiz').onclick=()=>{const quiz=lastFeedback.quiz;const area=document.createElement('div');area.className='live-quiz';area.innerHTML='<p>'+escape(quiz.question)+'</p><button data-answer="yes">'+escape(quiz.yes)+'</button> <button data-answer="no">'+escape(quiz.no)+'</button><p class="quiz-feedback"></p>';box.querySelector('.live-quiz')?.remove();$('live-detail').append(area);area.querySelectorAll('[data-answer]').forEach(b=>b.onclick=()=>{const correct=b.dataset.answer==='yes';area.querySelector('.quiz-feedback').textContent=(correct?'答对了。':'再想一想。')+quiz.explanation;if(correct&&!preview&&!coachMemory.lessons.includes(quiz.id)){coachMemory.lessons.push(quiz.id);saveCoachMemory();}});};
 if(force||!hint||autoCalls>=(profile.coach.mode==='mentor'?6:3)||asking||hint.reason===lastAutoReason&&profile.coach.mode!=='mentor'||(profile.coach.mode!=='mentor'&&game.turn>1&&hint.reason==='回合结束，重新评估局面'))return;
 lastAutoReason=hint.reason;const context=matchContext();
 connectionStatus().then(status=>{if(hintEpoch!==token)return null;if(!status.configured){speakCue(hint.text);return null;}autoCalls++;$('live-provider').textContent='小芽正在组织解释…';return requestCoach({message:'这回合怎么打？直接对玩家说一句有用的话：结合当前宠物、血量、能量点出最值得注意的一件事；有合适行动就解释缘由，不强求每回合纠错。最多60字。',role:'strategist',context,memory:coachMemory,conversation:[],cache:true,stateToken:token});}).then(answer=>{if(!answer||hintEpoch!==token)return;const explanation=document.createElement('p');explanation.textContent=concise(answer.text,180);$('live-detail').querySelector('p')?.replaceWith(explanation);$('live-copy').textContent=concise(answer.text,90);speakCue(answer.text);$('live-provider').textContent=answer.provider==='deepseek'?'DeepSeek · 结合局面解释':answer.fallbackReason||'本地教练';}).catch(()=>{if(hintEpoch===token){$('live-provider').textContent='模型暂不可用 · 保留规则建议';speakCue(hint.text);}});
}

$('round-coach').onclick=()=>{if(!busy){openCoach();ask(game?.result?'回顾上一局':'回顾上一回合');}};

// One short cue per decision, at most twice per match; no model request per mouse move.
$('actions').addEventListener('pointerover',event=>{
 const button=event.target.closest('[data-action]');if(!button||button.disabled||busy||!game)return;
 hoverAction=JSON.parse(button.dataset.action);
 trackAttention(attention,game.turn+':'+game.phase,button.dataset.action,Date.now());
});
$('actions').addEventListener('focusin',event=>{
 const button=event.target.closest('[data-action]');if(button&&!button.disabled&&game){hoverAction=JSON.parse(button.dataset.action);trackAttention(attention,game.turn+':'+game.phase,button.dataset.action,Date.now());}
});
$('attention-close').onclick=()=>{cancelVoice();logCoachEvent('dismiss','attention');attention.dismissed=true;coachMuted=true;coachSession.dismissed=true;$('live-coach').hidden=true;hintEpoch++;$('attention-cue').hidden=true;};
document.addEventListener('visibilitychange',()=>{if(document.hidden){advanceContext();hintEpoch++;cancelVoice();$('attention-cue').hidden=true;attention.since=Date.now();}else{attention.since=Date.now();attention.hovers=[];}});
setInterval(()=>{
 if(!game)return;const now=Date.now(),turn=game.turn+':'+game.phase;
 trackAttention(attention,turn,null,now);
 const allowed=!busy&&!asking&&!preview&&!game.result&&coachAllowedInMatch()&&!document.hidden&&document.hasFocus()&&$('coach-panel').hidden;
 if(allowed&&showWatchCue())return;
 if(allowed&&showTacticalCue())return;
 if(!$('attention-cue').hidden)return;
 const risk=active(game,'player').hp/active(game,'player').maxHp<.3||game.phase==='replace';
 if(!shouldNudge(attention,{now,turn,mode:profile.coach.mode,active:allowed,risk}))return;
 const text=attentionText(game,hoverAction);if(!text)return;
 if(!adaptiveGate(coachMemory,{lesson:hoverAction?.kind==='switch'?'换宠承伤':hoverAction?.id==='guard'?'防御节奏':'行动取舍',risk,mode:profile.coach.mode}).allow)return;
 logCoachEvent('hint','attention');attention.count++;attention.lastShown=now;attention.shownTurn=turn;
 $('attention-text').textContent=text;$('attention-cue').hidden=false;speakCue(text);
 clearTimeout(nudgeTimer);nudgeTimer=setTimeout(()=>$('attention-cue').hidden=true,10000);
},1000);

function showTacticalCue(){
 if(!game||busy||preview||document.hidden||!document.hasFocus()||!$('coach-panel').hidden||profile.coach.mode==='quiet'||coachMuted||attention.dismissed||tacticalCount>=3||game.turn-lastTacticalTurn<3)return false;
 const cue=decisiveOpportunity(game);if(!cue||tacticalShown.has(cue.id))return false;
 logCoachEvent('hint','endgame');tacticalShown.add(cue.id);tacticalCount++;lastTacticalTurn=game.turn;
 attention.lastShown=Date.now();attention.shownTurn=game.turn+':'+game.phase;
 $('attention-text').textContent=cue.text;$('attention-cue').hidden=false;speakCue(cue.text);
 clearTimeout(nudgeTimer);nudgeTimer=setTimeout(()=>$('attention-cue').hidden=true,12000);return true;
}
function renderGrowthCoach(){
 if(preview)return;
 const anchor=$('cultivation-coach');if(!anchor)return;
 const packet=teacher({...buildContext(null,profile,focus,roundArchive,stageId),goal:coachMemory.goal,favorite:coachMemory.favorite});
 const key=focus+':'+stageId;
 const box=document.createElement('div');box.className='growth-advice';box.id='growth-advice';
 const compact=packet.headline||packet.brief||concise(packet.text,70);
 const show=()=>{box.innerHTML='<div class="advice-head"><strong>✦ 小芽</strong><span class="growth-headline">'+escape(compact)+'</span><button id="growth-advice-close" aria-label="收起培养建议">×</button></div><p class="advice-reason">'+escape(packet.reason||'')+'</p><details><summary>看数值对比</summary><table class="growth-table"><thead><tr><th>项目</th><th>现在</th><th>加1点后</th></tr></thead><tbody>'+packet.comparisons.map(r=>'<tr>'+r.map(c=>'<td>'+escape(c)+'</td>').join('')+'</tr>').join('')+'</tbody></table><small>每次消耗 1 训练点；受培养格数与单项上限约束，加错了可以免费重置。</small></details>';$('growth-advice-close').onclick=()=>{growthDismissed=key;box.hidden=true;anchor.hidden=false;};};
 $('cultivation').querySelector('h3').after(box);box.hidden=!adaptiveGate(coachMemory,{lesson:'培养',mode:profile.coach.mode}).allow||growthDismissed===key;anchor.textContent='✦ 展开培养建议';anchor.hidden=!box.hidden;
 anchor.onclick=()=>{box.hidden=false;anchor.hidden=true;show();};show();
}

function logCoachEvent(kind,channel){if(!game||preview)return;coachMemory=recordCoachEvent(coachMemory,{id:`${matchId}:${game.turn}:${kind}:${channel}`,kind,channel,matchId,turn:game.turn,rulesVersion:game.version,confidence:1});saveCoachMemory();}

// 语音总开关。浏览器语音在本机 macOS Chrome 上不稳定：无论指定哪个 zh-CN 声音，
// 都会播成粤语并在结尾爆音，触发点是 speechSynthesis.cancel()，且无法恢复。
// 原因未查明前整体停用；代码与设置项保留，把下面改成 true 即可恢复。
const VOICE_FEATURE=false;
let voiceEnabled=false,voiceVolume=.5,lastSpoken='';
try{const setting=JSON.parse(localStorage.getItem('xiaoya-voice')||'{}');voiceEnabled=VOICE_FEATURE&&setting.enabled===true;voiceVolume=Number.isFinite(setting.volume)?Math.max(0,Math.min(1,setting.volume)):.5;voiceName=typeof setting.voice==='string'?setting.voice:'';}catch{}
$('voice-enabled').checked=voiceEnabled;$('voice-volume').value=voiceVolume;
if(!VOICE_FEATURE){
 // 隐藏全部语音控件，只留一行说明；同时把已保存的开启状态改回关闭。
 for(const id of ['voice-enabled','voice-volume','voice-test','voice-pick']){const el=$(id),row=el&&el.closest('.coach-pref');if(row)row.hidden=true;}
 $('voice-status').textContent='语音已暂停使用 · 文字提示与其余功能不受影响';
 try{const raw=localStorage.getItem('xiaoya-voice');if(raw){const setting=JSON.parse(raw);setting.enabled=false;localStorage.setItem('xiaoya-voice',JSON.stringify(setting));}}catch{}
}else if(!('speechSynthesis' in window)){$('voice-enabled').disabled=true;$('voice-status').textContent='当前浏览器不支持语音，仍可查看文字';}
let utterance=null,chosenVoice=null,voiceName='',lastCancelAt=0;
function voiceStatus(text){$('voice-status').textContent=text;}
// 只挑普通话。zext 的 startsWith('zh') 会命中 zh-HK（粤语）与 zh-TW，
// 而 getVoices() 首次调用常常返回空数组 —— 这正是"第一次普通话、之后粤语"的原因。
// 已知的普通话声音，优先于系统里排在前面但可能不是普通话的声音。
const MANDARIN=/婷婷|Ting-?Ting|Google 普通话|Mei-?Jia|美佳|美嘉|Yaoyao|Xiaoxiao|Xiaoyi|Yunxi|Yunyang|普通话/i;
// macOS 的英文趣味语音（Eddy/Flo/Grandma…）会被 Chrome 按 zh-CN 列出来，但它们是英文
// 声音在读中文，听起来像怪腔或粤语。自动选择时排除；用户仍可在下拉里手动选。
const NOVELTY=/^(Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley|Junior|Ralph|Kathy|Princess|Fred|Albert|Bahh|Bells|Boing|Bubbles|Cellos|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Good News|Bad News)\b/i;
const CN_ONLY=v=>/^zh/i.test(String(v.lang||''));
function chineseVoices(){return (window.speechSynthesis?.getVoices?.()||[]).filter(CN_ONLY);}
function findVoice(name){
 if(!name)return null;const list=window.speechSynthesis?.getVoices?.()||[];
 return list.find(v=>v.name===name)||null;
}
// 用户显式选过就用他的；否则挑一个已知普通话，再不行退回任何 zh-CN。
function resolveVoice(){
 const picked=findVoice(voiceName);if(picked)return picked;
 const list=chineseVoices();
 const mainland=list.filter(v=>/^zh-cn/i.test(String(v.lang||'').replace('_','-')));
 const real=mainland.filter(v=>!NOVELTY.test(v.name));
 return real.find(v=>MANDARIN.test(v.name))||real[0]||mainland.find(v=>MANDARIN.test(v.name))||mainland[0]||null;
}
function renderVoiceOptions(){
 const sel=$('voice-pick');if(!sel)return;
 const list=chineseVoices();
 const best=resolveVoice();
 sel.innerHTML='<option value="">（自动选择）</option>'+list.map(v=>`<option value="${escape(v.name)}">${escape(v.name)} · ${escape(v.lang)}</option>`).join('');
 sel.value=voiceName&&list.some(v=>v.name===voiceName)?voiceName:'';
 return best;
}
if(window.speechSynthesis){
 window.speechSynthesis.onvoiceschanged=()=>{const best=renderVoiceOptions();chosenVoice=best;};
 renderVoiceOptions();
}
// 不再调用 speechSynthesis.cancel()。macOS Chrome 上它会持久破坏后续播报的声音选择：
// 之后无论 utterance.voice 设成哪个 zh-CN 声音，实际都播成粤语，并在结尾爆音；
// 实测间隔 300ms 也无法恢复，只有刷新页面才复原。因此这里只做「标记作废」。
// 代价：已经开口的那一句会读完（提示都很短），无法中途掐断。
function cancelVoice(){utterance=null;lastCancelAt=Date.now();}
function playVoice(text,{test=false}={}){
 if(!VOICE_FEATURE){voiceStatus('语音功能已暂停使用，文字提示不受影响');return;}
 if(!window.speechSynthesis){voiceStatus('当前浏览器不支持语音，请使用文字');return;}
 if(voiceVolume===0){voiceStatus('音量为0，请调高后试听');return;}
 const synth=window.speechSynthesis;
 // 播报路径里绝不 cancel。macOS Chrome 上 cancel() 之后紧接着 speak() 会让引擎沿用
 // 上一次的坏状态：换成另一个声音（本机表现为粤语）并在结尾爆音。已在播的先让它播完，
 // 排队超过一条就跳过，宁可少说一句。
 if(synth.speaking||synth.pending){voiceStatus('上一条还在播报，本次提示跳过（不会打断）');return;}
 // utterance 也尽量晚创建：cancel 之后重建实例才拿得到正确的声音。
 const fire=()=>{
  const u=new SpeechSynthesisUtterance(concise(text,90));
  const v=resolveVoice();if(v)chosenVoice=v;
  u.voice=v||null;u.lang=v?v.lang:'zh-CN';u.volume=voiceVolume;u.rate=1;u.pitch=1;
  utterance=u;
  voiceStatus((test?'试听 · ':'播报 · ')+(v?v.name+'（'+v.lang+'）':'系统默认中文声音'));
  u.onstart=()=>voiceStatus('正在播报 · '+(u.voice?u.voice.name:'系统默认'));
  u.onend=()=>{if(utterance===u){utterance=null;voiceStatus('播报结束 · '+(u.voice?u.voice.name+'（'+u.voice.lang+'）':'系统默认'));}};
  u.onerror=e=>{if(!['interrupted','canceled'].includes(e.error))voiceStatus('语音未播放：'+({ 'not-allowed':'请点试听解锁播放', 'voice-unavailable':'系统没有可用语音', 'language-unavailable':'系统缺少中文语音','audio-busy':'音频设备忙'}[e.error]||'请检查浏览器及系统声音设置'));};
  if(synth.paused)synth.resume();
  synth.speak(u);
 };
 const wait=0;
 setTimeout(fire,wait);
 setTimeout(()=>{if(utterance&&!synth.speaking&&!synth.pending)voiceStatus('未检测到播放，请点试听并检查系统中文语音');},wait+1500);
}
function speakCue(text){if(!voiceEnabled||document.hidden||busy||preview||profile.coach.mode==='quiet'||!game||!coachAllowedInMatch())return;const id=matchId+':'+game.turn+':'+text;if(lastSpoken===id)return;lastSpoken=id;playVoice(text);}
function saveVoice(){try{localStorage.setItem('xiaoya-voice',JSON.stringify({enabled:voiceEnabled,volume:voiceVolume,voice:voiceName}));}catch{}}
$('voice-test').onclick=()=>playVoice('我是小芽。有需要时，我会简短提醒。',{test:true});
$('voice-enabled').onchange=()=>{voiceEnabled=$('voice-enabled').checked;cancelVoice();saveVoice();if(voiceEnabled)playVoice('语音已开启，我会按你的陪伴风格提醒。',{test:true});else voiceStatus('语音已关闭（已开口的一句会读完，不再有新的）');};
$('voice-pick').onchange=()=>{voiceName=$('voice-pick').value;cancelVoice();saveVoice();const v=resolveVoice();voiceStatus(voiceName?('已选择 '+voiceName+'（'+(v?v.lang:'')+'）'):('自动选择：'+(v?v.name+'（'+v.lang+'）':'无可用中文声音')));if(voiceEnabled)playVoice('这是当前的播报声音。',{test:true});};
$('voice-volume').oninput=()=>{voiceVolume=Number($('voice-volume').value);cancelVoice();saveVoice();voiceStatus(voiceVolume===0?'音量为0':voiceEnabled?'语音已开启，可点试听':'语音未开启，可点试听');};
if(!VOICE_FEATURE)voiceStatus('语音已暂停使用 · 文字提示与其余功能不受影响');
else if('speechSynthesis' in window)voiceStatus(voiceEnabled?'语音已开启，可点试听':'语音未开启，可点试听');
$('reset-habits').onclick=()=>{coachMemory.journal=[];coachMemory.reflections={};saveCoachMemory();addChat('小芽','已清除行动观察和提醒习惯。你设置的提醒档位、游戏成长和战报都保留。');};

function showWatchCue(){if(profile.coach.mode==='quiet'||coachMuted||attention.dismissed)return false;const cue=watchCandidate(game,coachMemory.watches);if(!cue)return false;coachMemory.watches=coachMemory.watches.filter(w=>w.id!==cue.id);logCoachEvent('hint','watch');saveCoachMemory();$('attention-text').textContent=cue.text;$('attention-cue').hidden=false;attention.shownTurn=game.turn+':'+game.phase;attention.lastShown=Date.now();speakCue(cue.text);clearTimeout(nudgeTimer);nudgeTimer=setTimeout(()=>$('attention-cue').hidden=true,10000);return true;}

// First-use choice is a preference, not a forced tutorial or skill assessment.
document.querySelectorAll('[data-style]').forEach(button=>button.onclick=()=>{
 profile.coach.mode=button.dataset.style;voiceEnabled=$('welcome-voice').checked;$('voice-enabled').checked=voiceEnabled;save();saveVoice();
 try{localStorage.setItem('xiaoya-style-chosen','1');}catch{}
 $('coach-welcome').close();if(voiceEnabled)playVoice('好，就按你喜欢的方式来。',{test:true});cultivation();
});
try{if(!localStorage.getItem('xiaoya-style-chosen'))$('coach-welcome').showModal();}catch{}
