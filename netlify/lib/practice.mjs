// Practice accounts let production rehearse the portal. They are recognised by a
// name that starts with the word "Test" and are never published, counted or chased.
// Every part of the portal uses this one rule so a practice account cannot be
// private in one place and public in another.
export const practiceName=name=>/^test(?:\s|$)/i.test(String(name||'').trim());
