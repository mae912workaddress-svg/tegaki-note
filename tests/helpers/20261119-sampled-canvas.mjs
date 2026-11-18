import { pointInPolygon } from '../../src/model/geometry.js';

export function over(below, above) {
  const alpha=above[3]+below[3]*(1-above[3]);
  return alpha ? [0,1,2].map(i=>(above[i]*above[3]+below[i]*below[3]*(1-above[3]))/alpha).concat(alpha) : [0,0,0,0];
}

// Page-coordinate samples exercise ordering, clipping and source-over alpha.
// Glyphs use rectangles here; this is not a browser rasterizer/antialiasing test.
export function sampledCanvas(canvas, points) {
  const pixels=points.map(()=>[0,0,0,0]),calls=[],stack=[];
  let path=[],rects=[],clip=()=>true;
  const color=hex=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).concat(1);
  const inside=(p,x,y,w,h)=>p[0]>=x&&p[0]<x+w&&p[1]>=y&&p[1]<y+h;
  const paint=(hit,rgba,clear=false)=>points.forEach((p,i)=>{
    if(clip(p)&&hit(p)) pixels[i]=clear?[0,0,0,0]:over(pixels[i],[...rgba.slice(0,3),rgba[3]*ctx.globalAlpha]);
  });
  const ctx={canvas,globalAlpha:1,fillStyle:'#000000',font:'10px sans-serif',textBaseline:'top',
    save(){stack.push({clip,globalAlpha:this.globalAlpha,fillStyle:this.fillStyle,font:this.font});},
    restore(){const {clip:previous,...state}=stack.pop();Object.assign(this,state);clip=previous;},
    setTransform(){},setLineDash(){},stroke(){},strokeRect(){},arc(){},
    beginPath(){path=[];rects=[];},moveTo(x,y){path.push([x,y]);},lineTo(x,y){path.push([x,y]);},closePath(){},
    rect(x,y,w,h){rects.push([x,y,w,h]);path.push([x,y],[x+w,y],[x+w,y+h],[x,y+h]);},
    clip(){const polygon=path.slice(),boxes=rects.slice(),previous=clip;clip=p=>previous(p)&&(boxes.length?boxes.some(box=>inside(p,...box)):pointInPolygon(p,polygon));calls.push(['clip',polygon]);},
    clearRect(x,y,w,h){paint(p=>inside(p,x,y,w,h),[],true);calls.push(['clear']);},
    fillRect(x,y,w,h){paint(p=>inside(p,x,y,w,h),color(this.fillStyle));calls.push(['paper']);},
    fill(){if(path.length){paint(p=>pointInPolygon(p,path),color(this.fillStyle));calls.push(['ink',this.globalAlpha]);}},
    drawImage(image,x,y,w,h){paint(p=>inside(p,x,y,w,h),image.rgba);calls.push(['image',image.name]);},
    measureText(text){return {width:text.length*10};},
    fillText(text,x,y){paint(p=>inside(p,x,y,text.length*10,parseFloat(this.font)),color(this.fillStyle));calls.push(['text',text]);}
  };
  return {ctx,pixels,calls};
}
