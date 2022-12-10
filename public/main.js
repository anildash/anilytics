/* global io */

import {bind} from '/node_modules/viperhtml/index.js';
import {table} from './templates.js';

// Keep track of the number of hits whilst the page is open.
let hitCount = 0;

const render = bind(document.querySelector('main'));

document.querySelector('main').insertAdjacentHTML('beforebegin', '<label for="regex">Filter Results</label><input type="text" id="regex" placeholder="^https://anildash.com" />');

// This allows us to animate the numbers increasing when the user looks at it.
const queue = [];
(function loop() {
  const n = Math.max(queue.length, 1);
  setTimeout(() => {
    const n = queue.shift();
    if (n) n();
    requestAnimationFrame(loop);
  }, 20 + 400*Math.sqrt(1/n));
}());

let reg = new RegExp('');
(async function () {
  
  const socket = io(location.origin);
  let dbName;
  let data;
  let lastupdated = '';

  function makeTable() {
    try {
      reg = new RegExp(window.regex.value, 'i');
    } catch (e) {}
    render`
    ${table(dbName, 
      data
      .filter(a => a.url.match(reg))
      .sort((a,b) => b.counter - a.counter)
    , lastupdated, {refreshAllData})}`;
  }
  
  async function refreshAllData(dbNameIn) {
    switch(dbNameIn) {
      case 'Analytics':
        data = await fetch('./data.json').then(r => r.json());
        break;
      case 'Last30':
        data = await fetch('./since-last-month.json').then(r => r.json());
        break;
      case 'LastDay':
        data = await fetch('./since-yesterday.json').then(r => r.json());
        break;
      case 'YesterdayLog':
        data = await fetch('./yesterday.json').then(r => r.json());
        break;
      default:
        throw Error('Invalid DB ' + dbNameIn);
    }
    dbName = dbNameIn;
    makeTable();
  }

  await refreshAllData(new URLSearchParams(location.search).get('db') || 'Analytics');
  
  socket.on('connect', function(){
    console.log('connected');
  });
  
  socket.on('update', function(newRowData){
    if (dbName === 'YesterdayLog') return;
    lastupdated = newRowData.url;
    const result = data.find(row => row.url === newRowData.url);
    generateIcon(window.favicon, '📊', ++hitCount);
    queue.push(function () {
      if (result) {
        result.counter = newRowData.urlCounter[dbName];
      } else {
        data.push({
          url: newRowData.url,
          counter: newRowData.urlCounter[dbName]
        });
      }
      makeTable();
    });
  });
  socket.on('disconnect', function(){});
  
  window.regex.addEventListener('input', function () {
    makeTable();
  });
  
  function changeDBFromURL(urlIn) {
    const url = new URL(urlIn);
    if (url.pathname === '/') {
      const query = new URLSearchParams(url.search);
      let db = query.get('db') || 'Analytics';
      refreshAllData(db);
      return db;
    }
  }
  
  window.addEventListener('click', e => {
    if (e.target.tagName === 'A' && e.target.href.indexOf(location.origin) === 0) {
      if (e.target.href === location.href) {
          return e.preventDefault();
      }
      const newDB = changeDBFromURL(e.target.href);
      if (newDB) {
        e.preventDefault();
        history.pushState({}, newDB, e.target.href);
      }
    }
  });
  
  window.addEventListener('popstate', function () {
    changeDBFromURL(document.location.toString());
  });
  
}());

function generateIcon(link, emoji, count) {

  const padding=100/16;

  const svg = document. createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

  //<text y=%22.9em%22 font-size=%2290%22></text>
  //<text text-anchor=%22end%22 y=%221.9em%22 x=%221.9em%22 font-size=%2250%22>10</text>
  const t1 = document. createElementNS("http://www.w3.org/2000/svg", "text");
  t1.setAttribute('y', '.9em');
  t1.setAttribute('font-size', '90');
  t1.textContent = emoji;
  svg.appendChild(t1);
  
  if (count) {
    const t2 = document. createElementNS("http://www.w3.org/2000/svg", "text");
    t2.setAttribute('x', 100 - padding);
    t2.setAttribute('y', 100 - padding);
    t2.setAttribute('font-size', '60');
    t2.setAttribute('text-anchor', 'end');
    t2.setAttribute('alignment-baseline', 'text-bottom');
    t2.setAttribute('fill', 'white');
    t2.style.fontFamily = 'sans-serif';
    t2.style.fontWeight = '400';
    t2.textContent = count;
    svg.appendChild(t2);

    // measure the text
    document.body.appendChild(svg);
    const rect = t2.getBBox();
    document.body.removeChild(svg);

    const r1 = document. createElementNS("http://www.w3.org/2000/svg", "rect");
    r1.setAttribute('x', rect.x);
    r1.setAttribute('y', rect.y);
    r1.setAttribute('width', rect.width + padding);
    r1.setAttribute('height', rect.height + padding);
    r1.setAttribute('rx', padding);
    r1.setAttribute('ry', padding);
    r1.style.fill = 'red';
    svg.appendChild(r1);
    svg.appendChild(t2);
  }

  link.href='data:image/svg+xml,' + svg.outerHTML.replace(/"/ig, '%22');
}

// document.addEventListener("visibilitychange", () => {
//   if (!document.hidden) {
//     hitCount = 0;
//     generateIcon(window.favicon, '📊', hitCount);
//   }
// }, false);
generateIcon(window.favicon, '📊', hitCount);