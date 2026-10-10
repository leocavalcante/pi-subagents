/** Return false for lone UTF-16 surrogates that platform encoders replace with U+FFFD. */
export function isWellFormedUnicode(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			if (index + 1 >= value.length) return false;
			const lowSurrogate = value.charCodeAt(++index);
			if (lowSurrogate < 0xdc00 || lowSurrogate > 0xdfff) return false;
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			return false;
		}
	}
	return true;
}
