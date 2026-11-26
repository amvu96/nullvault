const C='context-v1.29',A=['./','./index.html','./manifest.json','./icon.svg','./icon-192.png','./icon-512.png','./apple-touch-icon.png'],
X=['https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css','https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/webfonts/fa-solid-900.woff2','https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/webfonts/fa-brands-400.woff2'];
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(C).then(c=>Promise.all([c.addAll(A),...X.map(u=>c.add(u).catch(()=>{}))])))});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{const r=e.request,u=new URL(r.url);if(r.method!=='GET')return;
 if(u.hostname==='cdnjs.cloudflare.com'){e.respondWith(caches.match(r).then(h=>h||fetch(r).then(n=>{const cp=n.clone();caches.open(C).then(c=>c.put(r,cp));return n})));return}
 if(u.origin!==location.origin)return;
 e.respondWith(fetch(r).then(n=>{const cp=n.clone();caches.open(C).then(c=>c.put(r,cp));return n}).catch(()=>caches.match(r).then(h=>h||caches.match('./index.html'))))});
