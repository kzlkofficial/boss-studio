/* Zero-dependency ZIP 'store' writer/reader; intentionally no compression. */
(function(root){'use strict';
const td=new TextDecoder(),te=new TextEncoder();
let table=[];for(let i=0;i<256;i++){let c=i;for(let k=0;k<8;k++)c=c&1?(0xedb88320^(c>>>1)):(c>>>1);table[i]=c>>>0;}
function crc(bytes){let c=0xffffffff;for(const b of bytes)c=table[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
function u16(v){const b=new Uint8Array(2);new DataView(b.buffer).setUint16(0,v,true);return b;}
function u32(v){const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,v>>>0,true);return b;}
function cat(...a){let n=a.reduce((p,v)=>p+v.length,0),b=new Uint8Array(n),i=0;for(let v of a){b.set(v,i);i+=v.length;}return b;}
function checkName(n){if(!n||n.startsWith('/')||n.includes('..')||n.includes('\\')||n.includes(':')||n.split('/').some(x=>x===''))throw Error('Недопустимое имя в архиве: '+n);return n;}
function make(map){let parts=[],central=[],pos=0;for(const [n,src] of Object.entries(map)){
 const name=te.encode(checkName(n)),bytes=src instanceof Uint8Array?src:typeof src==='string'?te.encode(src):new Uint8Array(src);
 if(bytes.length>0xffffffff)throw Error('Файл слишком большой');let c=crc(bytes),flags=0x800;
 let local=cat(u32(0x04034b50),u16(20),u16(flags),u16(0),u16(0),u16(0),u32(c),u32(bytes.length),u32(bytes.length),u16(name.length),u16(0),name);
 parts.push(local,bytes);
 let cd=cat(u32(0x02014b50),u16(20),u16(20),u16(flags),u16(0),u16(0),u16(0),u32(c),u32(bytes.length),u32(bytes.length),u16(name.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(pos),name);
 central.push(cd);pos+=local.length+bytes.length;
 }
 let centralSize=central.reduce((p,c)=>p+c.length,0);let end=cat(u32(0x06054b50),u16(0),u16(0),u16(central.length),u16(central.length),u32(centralSize),u32(pos),u16(0));
 return new Blob([...parts,...central,end],{type:'application/zip'});
}
function read(buffer){const b=new Uint8Array(buffer),v=new DataView(b.buffer,b.byteOffset,b.byteLength);let pos=0,out={};let count=0;
 while(pos+30<=b.length&&v.getUint32(pos,true)===0x04034b50){let flag=v.getUint16(pos+6,true),method=v.getUint16(pos+8,true);if(flag&8||method!==0)throw Error('Импорт поддерживает ZIP без сжатия, созданные в Boss Studio.');let c=v.getUint32(pos+14,true),size=v.getUint32(pos+18,true),nameLen=v.getUint16(pos+26,true),extra=v.getUint16(pos+28,true),start=pos+30+nameLen+extra,end=start+size;if(end>b.length)throw Error('ZIP повреждён');let name=checkName(td.decode(b.slice(pos+30,pos+30+nameLen)));let bytes=b.slice(start,end);if(crc(bytes)!==c)throw Error('CRC не совпадает: '+name);if(out[name])throw Error('Дубликат '+name);out[name]=bytes;count++;if(count>2000)throw Error('Слишком много файлов');pos=end;}
 if(!count)throw Error('В архиве нет файлов');return out;
}
root.BSZip={make,read,decode:b=>td.decode(b)};
})(typeof globalThis!=='undefined'?globalThis:this);
