/**
 * DEV-04 guard rules. findResidue is pure: it returns the names of the rules
 * a file breaks. The e-mail rule covers every tracked text file; the ox-*
 * rules cover recorded OX responses under test/fixtures/ox/ only.
 */

const OX_FIXTURES = "test/fixtures/ox/";

const RESERVED_DOMAINS = new Set([
	"example.invalid",
	"example.com",
	"example.org",
	"example.net",
]);
const RESERVED_SUFFIXES = [".invalid", ".test", ".example"];

const EMAIL =
	/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;

const FIXTURE_HOST = "dav.example.invalid";
const FIXTURE_FOLDER = "Last, First";
const FIXTURE_PROBE = "probe-2026-01-01";
const FIXTURE_DAY = "2026-01-01";
const FIXTURE_RFC1123_DAY = "01 Jan 2026";
const FIXTURE_QUOTAS = new Set(["", "1000000000", "1000"]);
const FIXTURE_NAME_PLACEHOLDERS = new Set([
	"",
	"Last, First",
	"First Last",
	"user@example.invalid",
]);
// Probe files are named p<2 digits><anything>, e.g. p02.txt or p10-new.txt.
const PROBE_FILE_NAME = /^p\d{2}[A-Za-z0-9._-]*$/;

function reservedEmailDomain(domain: string): boolean {
	const lower = domain.toLowerCase();
	return (
		RESERVED_DOMAINS.has(lower) ||
		RESERVED_SUFFIXES.some((suffix) => lower.endsWith(suffix))
	);
}

function hasForeignEmail(text: string): boolean {
	for (const match of text.matchAll(EMAIL)) {
		if (!reservedEmailDomain(match[1] ?? "")) return true;
	}
	return false;
}

function decoded(segment: string): string | undefined {
	try {
		return decodeURIComponent(segment);
	} catch {
		return undefined;
	}
}

function hasForeignHost(text: string): boolean {
	// Namespace declarations are identifiers, not hosts that were contacted.
	const bare = text.replace(/xmlns(?::[\w.-]+)?\s*=\s*("[^"]*"|'[^']*')/g, "");
	for (const match of bare.matchAll(/https?:\/\/([^\s/"'<>:?#]+)/gi)) {
		if ((match[1] ?? "").toLowerCase() !== FIXTURE_HOST) return true;
	}
	return false;
}

function hasForeignUserstore(text: string): boolean {
	for (const match of text.matchAll(/Userstore\/([^/\s"'<>]+)/g)) {
		if (decoded(match[1] ?? "") !== FIXTURE_FOLDER) return true;
	}
	return false;
}

function hasForeignProbeFolder(text: string): boolean {
	for (const match of text.matchAll(/probe-\d{4}-\d{2}-\d{2}/g)) {
		if (match[0] !== FIXTURE_PROBE) return true;
	}
	return false;
}

function hasForeignDate(text: string): boolean {
	const rfc1123 =
		/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+(\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4})/g;
	for (const match of text.matchAll(rfc1123)) {
		const day = (match[1] ?? "").replace(/\s+/g, " ");
		if (day.padStart(11, "0") !== FIXTURE_RFC1123_DAY) return true;
	}
	for (const match of text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) {
		if (match[0] !== FIXTURE_DAY) return true;
	}
	return false;
}

function hasForeignQuota(text: string): boolean {
	const quota =
		/<(?:[A-Za-z]+:)?quota-(?:available|used)-bytes(?:\s[^>]*)?>([^<]*)</g;
	for (const match of text.matchAll(quota)) {
		if (!FIXTURE_QUOTAS.has((match[1] ?? "").trim())) return true;
	}
	return false;
}

function hasForeignName(text: string): boolean {
	const element =
		/<(?:[A-Za-z]+:)?(?:displayname|owner|creator-displayname)(?:\s[^>]*)?>([^<]*)</g;
	for (const match of text.matchAll(element)) {
		const value = (match[1] ?? "").trim();
		if (FIXTURE_NAME_PLACEHOLDERS.has(value)) continue;
		if (value === FIXTURE_PROBE || PROBE_FILE_NAME.test(value)) continue;
		return true;
	}
	return false;
}

export function findResidue(path: string, text: string): string[] {
	const rules: string[] = [];
	if (hasForeignEmail(text)) rules.push("email");
	if (!path.startsWith(OX_FIXTURES)) return rules;
	if (/mailbox\.org/i.test(text)) rules.push("ox-mailbox-org");
	if (hasForeignHost(text)) rules.push("ox-host");
	if (/^[\s<>]*(?:set-cookie|cookie|authorization)\s*:/im.test(text)) {
		rules.push("ox-auth-header");
	}
	if (hasForeignUserstore(text)) rules.push("ox-userstore");
	if (hasForeignProbeFolder(text)) rules.push("ox-probe-folder");
	if (hasForeignDate(text)) rules.push("ox-date");
	if (hasForeignQuota(text)) rules.push("ox-quota");
	if (hasForeignName(text)) rules.push("ox-name-element");
	return rules;
}
