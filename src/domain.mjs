export function axisValue(fraction, minimum, maximum, logarithmic=false) {
  if (fraction<0 || fraction>1 || minimum>=maximum) throw new Error('坐标范围无效');
  if (logarithmic && minimum<=0) throw new Error('对数轴必须为正');
  return logarithmic ? Math.exp(Math.log(minimum)+fraction*Math.log(maximum/minimum)) : minimum+fraction*(maximum-minimum);
}
export function preview(data) {
 return data.series.map(row=>({id:row.id,label:row.label,unit:row.unit}));
}
