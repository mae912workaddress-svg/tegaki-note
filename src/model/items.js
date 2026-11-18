import { itemWidth, itemHeight } from './images.js';
import { pointInPolygon,moveStrokes } from './geometry.js';
export const pageContent = page => structuredClone({strokes:page.strokes,items:page.items});
export function itemHit(item, [x,y]) { return x >= item.x && y >= item.y && x <= item.x+itemWidth(item) && y <= item.y+itemHeight(item); }
export function selectItems(items,polygon) { return items.filter(i => [[i.x,i.y],[i.x+itemWidth(i),i.y],[i.x,i.y+itemHeight(i)],[i.x+itemWidth(i),i.y+itemHeight(i)]].every(p => pointInPolygon(p,polygon))).map(i => i.id); }
export function moveItems(items,ids,dx,dy,width,height) {
  return items.map(i => ids.includes(i.id) ? {...i,x:Math.max(0,Math.min(Math.max(0,width-itemWidth(i)),i.x+dx)),y:Math.max(0,Math.min(Math.max(0,height-itemHeight(i)),i.y+dy))} : i);
}
export function moveContent(content,ids,dx,dy,width,height) {
  const points=[];
  for(const stroke of content.strokes)if(ids.includes(stroke.id))for(const point of stroke.points)points.push(point);
  for(const item of content.items)if(ids.includes(item.id))points.push([item.x,item.y],[item.x+itemWidth(item),item.y+itemHeight(item)]);
  if(!points.length)return content;
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const [x,y] of points){minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}
  dx=Math.max(-minX,Math.min(width-maxX,dx));dy=Math.max(-minY,Math.min(height-maxY,dy));
  return {strokes:moveStrokes(content.strokes,ids,dx,dy,width,height),items:content.items.map(item=>ids.includes(item.id)?{...item,x:item.x+dx,y:item.y+dy}:item)};
}
