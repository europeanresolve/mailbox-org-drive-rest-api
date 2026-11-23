function fold(name: string): string {
	return name.toLowerCase();
}

/** Deterministic Excel sheet naming with length cap and ~N suffixes (D-23). */
export class SheetNamer {
	private readonly used = new Set<string>();

	constructor() {
		this.used.add(fold("history"));
	}

	/** Reserve a name (main sheet) so later candidates cannot take it. */
	reserve(name: string): string {
		const allocated = this.allocate(name);
		this.used.add(fold(allocated));
		return allocated;
	}

	/** Allocate a fresh name for an array or element sheet candidate. */
	name(candidate: string): string {
		const allocated = this.allocate(candidate);
		this.used.add(fold(allocated));
		return allocated;
	}

	private allocate(candidate: string): string {
		const folded = fold(candidate);
		if (candidate.length <= 31 && !this.used.has(folded)) {
			return candidate;
		}
		for (let n = 2; ; n += 1) {
			const suffix = `~${n}`;
			const baseLen = 31 - suffix.length;
			const base = candidate.slice(0, baseLen);
			const name = `${base}${suffix}`;
			if (!this.used.has(fold(name))) {
				return name;
			}
		}
	}
}
