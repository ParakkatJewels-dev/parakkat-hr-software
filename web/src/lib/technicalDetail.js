// Who is shown the technical side of a failure (round 3). HR and super admins - the people who
// manage the attendance devices and can act on "sync service not running" or a database error -
// see the detail; everyone else is told plainly that there is a technical issue being looked into.
//
// App sets this once it knows who is signed in; until then, and in tests, the detail shows.
let technical = true;

export function setTechnicalViewer(value) { technical = Boolean(value); }
export function showsTechnicalDetail() { return technical; }

export const FRIENDLY_ISSUE = 'A technical issue on our side is being looked into. Please try again in a little while.';
