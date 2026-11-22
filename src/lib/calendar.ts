/** Recordatorios de calendario: funcionan aunque la app esté cerrada */

const pad = (n: number) => String(n).padStart(2, '0');
const utc = (d: Date) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function addCalendarReminder(title: string, at: number, details = '') {
  const start = new Date(at);
  const end = new Date(at + 10 * 60000);
  if (isIOS()) {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//MiAutitoElectrico//ES',
      'BEGIN:VEVENT',
      `UID:${at}@miautito`,
      `DTSTAMP:${utc(new Date())}`,
      `DTSTART:${utc(start)}`,
      `DTEND:${utc(end)}`,
      `SUMMARY:${title}`,
      `DESCRIPTION:${details.replace(/\n/g, '\\n')}`,
      'BEGIN:VALARM',
      'TRIGGER:PT0M',
      'ACTION:DISPLAY',
      `DESCRIPTION:${title}`,
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'carga-auto.ics';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } else {
    const p = new URLSearchParams({ action: 'TEMPLATE', text: title, dates: `${utc(start)}/${utc(end)}`, details });
    window.open(`https://calendar.google.com/calendar/render?${p}`, '_blank');
  }
}
