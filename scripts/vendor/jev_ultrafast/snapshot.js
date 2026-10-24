(() => {
  if (!document.body) return null;
  const cache = window.__jevFast ||= {ids:new WeakMap(), nodes:new Map(), next:1};
  const identity = e => {
    if (!cache.ids.has(e)) cache.ids.set(e,cache.next++);
    const id=cache.ids.get(e); cache.nodes.set(id,e); return id;
  };
  for (const [id,e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  const safe = e => !['password','hidden'].includes(e.type);
  const queryAll = selector => {
    const found=[];
    const walk = root => {
      found.push(...root.querySelectorAll(selector));
      for (const e of root.querySelectorAll('*')) if (e.shadowRoot) walk(e.shadowRoot);
    };
    walk(document); return found;
  };
  const visible = e => !e.closest('[aria-hidden="true"],[inert]') &&
    e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const name = (e,seen=new Set()) => {
    if (!e || seen.has(e) || ['SCRIPT','STYLE','TEMPLATE','NOSCRIPT'].includes(e.tagName)) return '';
    seen.add(e);
    const referenced=(e.getAttribute('aria-labelledby')||'').split(/\s+/)
      .map(id=>name(document.getElementById(id),seen)).filter(Boolean).join(' ');
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels||[])].map(l=>name(l,seen)).filter(Boolean).join(' ') ||
      (['button','submit','reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (['INPUT','TEXTAREA'].includes(e.tagName) || e.isContentEditable ? '' : [...e.childNodes].map(n=>n.nodeType===3 ? n.textContent :
        n.nodeType===1 && n.getAttribute('aria-hidden')!=='true' ? name(n,seen) : '').join(' ').trim()) ||
      e.getAttribute('title') || e.getAttribute('placeholder') || e.getAttribute('name') || '';
  };
  const roles=['button','link','checkbox','radio','switch','tab','menuitem','menuitemradio',
    'option','gridcell','combobox','textbox','searchbox','spinbutton'];
  const selector='a,button,input,textarea,select,summary,[onclick],[contenteditable="true"],'+
    roles.map(role=>'[role="'+role+'"]').join(',');
  const role = e => {
    const explicit=e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName==='BUTTON' || e.tagName==='SUMMARY') return 'button';
    if (e.tagName==='A') return 'link';
    if (e.tagName==='SELECT') return 'combobox';
    if (e.tagName==='TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName==='INPUT') {
      if (e.type==='file') return 'file';
      if (['checkbox','radio'].includes(e.type)) return e.type;
      if (['button','submit','reset','image'].includes(e.type)) return 'button';
      if (e.type==='search') return 'searchbox';
      if (e.type==='number') return 'spinbutton';
      if (['text','email','url','tel'].includes(e.type)) return 'textbox';
    }
    if (e.hasAttribute('onclick')) return 'button';
    if (e.hasAttribute('tabindex') || getComputedStyle(e).cursor==='pointer') return 'button';
    return null;
  };
  cache.pageKey=()=>[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    queryAll('input,textarea,select').filter(safe)
      .map(e=>[identity(e),e.value,e.checked,e.selectedIndex,e.disabled,e.readOnly])];
  cache.guard=e=>{
    if (!e?.isConnected || !visible(e)) return null;
    const scope=e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [identity(e),role(e),name(e),e.value??null,e.checked??null,e.selectedIndex??null,
      e.readOnly??null,e.matches(':disabled'),e.getAttribute('aria-disabled'),
      e.getAttribute('aria-expanded'),e.getAttribute('aria-checked'),e.getAttribute('aria-selected'),
      e.getAttribute('href'),scope?.innerText?.slice(0,6000)||''];
  };
  const actions=[];
  const candidates=queryAll(selector), known=new Set(candidates);
  // Frameworks also expose clickable divs without native/ARIA semantics. Their
  // rendered pointer affordance and text become observed targets, never selectors
  // or coordinates invented by the model.
  for (const e of queryAll('[tabindex],div,span,label')) {
    if (known.has(e) || e.closest('a,button,input,textarea,select,[role="button"],[role="link"]') || !visible(e)) continue;
    if (getComputedStyle(e).cursor!=='pointer' && !e.hasAttribute('tabindex')) continue;
    const label=name(e); if (!label || label.length>180) continue;
    const p=e.parentElement;
    if (p && getComputedStyle(p).cursor==='pointer' && name(p).length<=180) continue;
    candidates.push(e); known.add(e);
  }
  for (const e of candidates) {
    if (e.type==='file' && !e.matches(':disabled')) {
      actions.push({node:identity(e),role:'file',label:name(e)||e.name||'Input file',kind:'upload',value:e.value,accept:e.accept,formNode:e.form?identity(e.form):null});
      continue;
    }
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2, rname=role(e);
    if (!rname || r.width<=0 || r.height<=0 || x<0 || y<0 || x>=innerWidth || y>=innerHeight) continue;
    let hit=document.elementFromPoint(x,y);
    while(hit?.shadowRoot?.elementFromPoint(x,y) && hit.shadowRoot.elementFromPoint(x,y)!==hit)
      hit=hit.shadowRoot.elementFromPoint(x,y);
    if (!e.contains(hit)) continue;
    if (rname==='gridcell' && e.querySelector('button,[role="button"]')) continue;
    const base={node:identity(e),role:rname,label:name(e)||rname,fieldName:e.getAttribute('name')||'',tag:e.tagName,
      formSubmit:Boolean(e.form && (['submit','image'].includes(e.type))), formNode:e.form?identity(e.form):null,
      rect:{x:r.x,y:r.y,w:r.width,h:r.height}};
    for (const key of ['checked','selected','expanded']) {
      const value=e.getAttribute('aria-'+key);
      if (value!==null) base[key]=value;
    }
    if (['checkbox','radio'].includes(e.type)) base.checked=String(e.checked);
    if (e.type==='file') {
      actions.push({...base,kind:'upload',value:e.value,accept:e.accept});
    } else if (e.tagName==='SELECT') {
      for (const o of e.options) if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
        actions.push({...base,kind:'select',value:o.value,
          current_value:[...e.selectedOptions].map(o=>o.label).join(', '),label:base.label+' → '+o.label});
    } else {
      const editable=!e.readOnly && e.getAttribute('aria-readonly')!=='true' &&
        (['textbox','searchbox','spinbutton'].includes(rname) ||
          (rname==='combobox' && ['INPUT','TEXTAREA'].includes(e.tagName)));
      const value='value' in e ? String(e.value) :
        e.isContentEditable || rname==='combobox' ? e.innerText.trim() : '';
      actions.push({...base,kind:editable?'fill':'click',value});
      if (editable) actions.push({...base,kind:'click',value,label:'Open '+base.label});
    }
  }
  for (const e of queryAll('*')) {
    if (!visible(e) || !/(auto|scroll)/.test(getComputedStyle(e).overflowY) || e.scrollHeight<=e.clientHeight+2) continue;
    const base={node:identity(e),kind:'scroll',role:'scrollbar',label:(e.getAttribute('aria-label')||e.getAttribute('title')||'Scrollable panel').slice(0,180)};
    if (e.scrollTop+e.clientHeight<e.scrollHeight-2) actions.push({...base,id:'panel_down_'+identity(e),delta:560,label:base.label+' down'});
    if (e.scrollTop>0) actions.push({...base,id:'panel_up_'+identity(e),delta:-560,label:base.label+' up'});
  }
  const words=[], walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  const range=document.createRange(); let node,length=0;
  while ((node=walker.nextNode()) && length<6000) {
    const value=node.textContent.trim(), parent=node.parentElement;
    if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
    range.selectNodeContents(node); const r=range.getBoundingClientRect();
    if (r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth) {
      words.push(value); length+=value.length;
    }
  }
  const text=words.join('\n').slice(0,6000), height=document.documentElement.scrollHeight;
  const page_key=cache.pageKey(), guards={};
  for (const a of actions) if (!(a.node in guards)) guards[a.node]=cache.guard(cache.nodes.get(a.node));
  // Compare meaning and identity. Geometry is always resolved and hit-tested just before input.
  const semantics=actions.map(({rect,...action})=>action);
  const marker=[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    document.title,text,semantics,page_key[6]];
  const omitted_actions=Math.max(0,actions.length-250);
  actions.splice(250);
  actions.forEach((a,i)=>a.id='e'+(i+1));
  if (scrollY+innerHeight<height-2) actions.push({id:'scroll_down',kind:'scroll',label:'Scroll down',delta:560});
  if (scrollY>0) actions.push({id:'scroll_up',kind:'scroll',label:'Scroll up',delta:-560});
  actions.push({id:'wait',kind:'wait',label:'Wait for the page to update'});
  return {url:location.href,title:document.title,w:innerWidth,h:innerHeight,text,
    scroll:{y:scrollY,height},actions,marker,page_key,guards,omitted_actions};
})()
