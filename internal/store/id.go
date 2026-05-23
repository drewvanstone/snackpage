package store

import "crypto/rand"

const crockfordAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// NewID returns an 8-char Crockford base32 identifier from crypto/rand.
// Uniform: 256 mod 32 == 0, so byte % 32 has no bias.
func NewID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand never returns an error in normal operation;
		// if it does, fail loudly rather than silently emit a weak ID.
		panic("snackpage: crypto/rand.Read: " + err.Error())
	}
	for i := range b {
		b[i] = crockfordAlphabet[b[i]%32]
	}
	return string(b[:])
}
