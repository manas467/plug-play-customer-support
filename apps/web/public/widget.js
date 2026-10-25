(function(){
  var script=document.currentScript;
  if(!script)return;
  var key=script.getAttribute('data-key');
  if(!key)return;
  var base=script.src.replace(/\/widget\.js(?:\?.*)?$/,'');
  var api=(script.getAttribute('data-api')||'http://localhost:4000/api').replace(/\/$/,'');
  var accent=script.getAttribute('data-color')||'#5b5bd6';
  var button=document.createElement('button');
  button.type='button';button.setAttribute('aria-label','Open support chat');
  button.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8A8.5 8.5 0 0 1 8.7 3.9a8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z"/></svg>';
  Object.assign(button.style,{position:'fixed',right:'24px',bottom:'24px',width:'58px',height:'58px',borderRadius:'50%',border:'0',background:accent,color:'#fff',boxShadow:'0 8px 28px #2223',cursor:'pointer',zIndex:'2147483646',display:'grid',placeItems:'center'});
  var svg=button.querySelector('svg');Object.assign(svg.style,{width:'25px',height:'25px',fill:'none',stroke:'currentColor',strokeWidth:'1.8',strokeLinecap:'round',strokeLinejoin:'round'});
  fetch(api+'/widget/'+encodeURIComponent(key)+'/bootstrap').then(function(response){if(!response.ok)throw new Error('Widget domain is not authorized');return response.json();}).then(function(payload){
    var frame=document.createElement('iframe');frame.title='Customer support chat';frame.src=base+'/widget.html?key='+encodeURIComponent(key)+'&token='+encodeURIComponent(payload.token);frame.allow='clipboard-read; clipboard-write';
    Object.assign(frame.style,{position:'fixed',right:'24px',bottom:'96px',width:'380px',height:'590px',maxHeight:'calc(100vh - 120px)',border:'0',borderRadius:'20px',boxShadow:'0 14px 50px #15213a30',zIndex:'2147483645',display:'none',background:'transparent'});
    button.addEventListener('click',function(){var open=frame.style.display==='none';frame.style.display=open?'block':'none';button.setAttribute('aria-expanded',String(open));});
    document.body.appendChild(frame);document.body.appendChild(button);
    window.addEventListener('message',function(event){if(event.data==='support-widget:close')frame.style.display='none';});
    window.addEventListener('resize',function(){if(window.innerWidth<430){frame.style.right='8px';frame.style.left='8px';frame.style.width='auto';frame.style.bottom='82px';frame.style.height='calc(100vh - 100px)';}});
  }).catch(function(error){console.warn('[Helpwise] '+error.message);});
})();
