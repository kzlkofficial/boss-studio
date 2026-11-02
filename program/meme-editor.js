(()=>{'use strict';const $=id=>document.getElementById(id);let token='',viewerUrl='';const localViewer='http://127.0.0.1:8766/claim';
async function get(path){const r=await fetch(path,{cache:'no-store'}),d=await r.json();if(!r.ok||!d.ok)throw Error(d.error||'Ошибка подключения');return d}
async function post(path,body){const r=await fetch(path,{method:'POST',headers:{'X-Boss-Studio-Token':token,'Content-Type':'application/json'},body:JSON.stringify(body)}),d=await r.json();if(!r.ok||!d.ok)throw Error(d.error||'Ошибка сохранения');return d}
function msg(value){$('memeStatus').textContent=value}
async function copy(value){if(!value)throw Error('Поле пока пустое');if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(value);return}const area=document.createElement('textarea');area.value=value;area.style.cssText='position:fixed;left:-9999px';document.body.append(area);area.select();const ok=document.execCommand('copy');area.remove();if(!ok)throw Error('Браузер не разрешил копирование')}
document.querySelectorAll('[data-eye]').forEach(button=>button.onclick=()=>{const field=$(button.dataset.eye);field.type=field.type==='password'?'text':'password';button.setAttribute('aria-label',field.type==='password'?'Показать':'Скрыть')});
document.querySelectorAll('[data-copy]').forEach(button=>button.onclick=async()=>{try{await copy($(button.dataset.copy).value);msg('✓ Значение скопировано, показ на экране не менялся.')}catch(e){msg('⚠ '+e.message)}});
async function refresh(){const d=await get('/api/rewards/status');$('memeClaimLink').value=d.publicBaseUrl?d.publicBaseUrl+'/claim':'';$('memePublicUrl').value=d.publicBaseUrl||'';viewerUrl=d.publicBaseUrl?d.publicBaseUrl+'/claim':d.localViewerUrl;$('memeChatStatus').textContent=d.chatStatus||'Для отправки ссылки нужен Streamer.bot';msg(d.publicBaseUrl?'Страница зрителя настроена. Заявки видны в управлении эфиром.':'Укажи публичный HTTPS-адрес для ссылки в чат. Локальный предпросмотр доступен без него.')}
$('memeClaimSetup').onclick=async()=>{try{await post('/api/rewards/setup',{publicBaseUrl:$('memePublicUrl').value.trim(),streamerPassword:$('streamerPassword').value});$('streamerPassword').value='';await refresh();msg('✓ Адрес сохранён. Никакое приложение MemeAlerts не требуется.')}catch(e){msg('⚠ '+e.message)}};
$('memeOpenViewer').onclick=()=>window.open(viewerUrl||localViewer,'_blank','noopener');
$('memeOpenDemo').onclick=()=>window.open(localViewer+'?demo=1','_blank','noopener');
get('/api/status').then(d=>{token=d.token;return refresh()}).catch(e=>msg('⚠ '+e.message));
})();
