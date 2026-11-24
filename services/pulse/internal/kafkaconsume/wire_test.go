package kafkaconsume

import (
	"bytes"
	"testing"
)

// Confluent's protobuf framing: magic byte 0, a 4-byte schema id, the message-index list, then the protobuf bytes.
func TestStripConfluentHeader_SingleZeroIndex(t *testing.T) {
	// The first message in the .proto file is written as the single byte 0.
	got, err := StripConfluentHeader([]byte{0, 0, 0, 0, 7, 0, 0x0a, 0x01, 'x'})
	if err != nil || !bytes.Equal(got, []byte{0x0a, 0x01, 'x'}) {
		t.Fatalf("got %v, %v", got, err)
	}
}

func TestStripConfluentHeader_ExplicitIndexes(t *testing.T) {
	// Indexes [1, 0]: count 2, then 1 and 0, as zigzag varints (2 → 0x04, 1 → 0x02, 0 → 0x00).
	got, err := StripConfluentHeader([]byte{0, 0, 0, 1, 2, 0x04, 0x02, 0x00, 0x10, 0x05})
	if err != nil || !bytes.Equal(got, []byte{0x10, 0x05}) {
		t.Fatalf("got %v, %v", got, err)
	}
}

func TestStripConfluentHeader_BadMagic(t *testing.T) {
	if _, err := StripConfluentHeader([]byte{1, 0, 0, 0, 7, 0, 0x0a}); err == nil {
		t.Fatal("want an error for a non-zero magic byte")
	}
}

func TestStripConfluentHeader_TooShort(t *testing.T) {
	if _, err := StripConfluentHeader([]byte{0, 0, 0}); err == nil {
		t.Fatal("want an error for a truncated header")
	}
}
