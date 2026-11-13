let state=await(await fetch('/api/snapshot')).json();
let selected='s1';let revision=0;
for(const series of state.series){const button=document.createElement('button');button.textContent=series.label;button.dataset.series=series.id;button.onclick=()=>{selected=series.id;revision++;};document.querySelector('#legend').append(button);}
document.querySelector('#zoom').onclick=()=>{revision++;state.view++;document.querySelector('#plot').dataset.view=String(state.view);};
document.querySelector('#plot').onmousemove=event=>{
 const fraction=event.offsetX/600;const index=Math.min(3,Math.max(0,Math.round(fraction*3)));
 const series=state.series.find(row=>row.id===selected);const point=series.points[index];const captured=revision;
 setTimeout(()=>{document.querySelector('#tip').textContent=JSON.stringify({series:series.id,label:series.label,range:[Math.max(0,index/3-.1),Math.min(1,index/3+.1)],x:point[0],value:point[1],unit:series.unit,revision:captured,view:state.view});},index===2?180:15);
};
window.portalReady=true;
