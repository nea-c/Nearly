// Adopted A: bright backgrounds, bold dark symbols, clockwise sync, fixed upper-right 50%.
export const badgeStates=['sync','done','error','paused'];
export const badgeColors={sync:'#55d6fa',done:'#4ade80',error:'#ff7780',paused:'#f1c369'};
const marks={
 sync:'<path d="M12.5 9.6A4.8 4.8 0 1 1 10.2 3.7L12 4.6"/><path d="M9.3 2.1L12 4.6L8.5 5.7"/>',
 done:'<path d="M3.8 8.1 6.7 11 12.1 5.1"/>',
 error:'<path d="M8 4.1v4.8"/><circle cx="8" cy="11.8" r="1.1" fill="#17212B" stroke="none"/>',
 paused:'<path d="M5.8 4.6v6.8M10.2 4.6v6.8"/>'
};
export function statusBadgeSvg(state,baseDataUrl,size=32){
 if(!badgeStates.includes(state))throw Error('Unknown badge state');
 if(!Number.isInteger(size)||size<16)throw Error('Invalid icon size');
 return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32"><image href="${baseDataUrl}" width="32" height="32" style="image-rendering:pixelated"/><svg x="16" y="0" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="${badgeColors[state]}"/><g fill="none" stroke="#17212B" stroke-width="2.35" stroke-linecap="round" stroke-linejoin="round">${marks[state]}</g></svg></svg>`;
}
