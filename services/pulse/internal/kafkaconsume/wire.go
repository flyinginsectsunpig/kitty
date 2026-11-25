package kafkaconsume

import (
	"encoding/binary"
	"errors"
)

// StripConfluentHeader returns the protobuf bytes from a value written by a Confluent (schema-registry) protobuf
// serializer: magic byte 0, a 4-byte schema id, then the message-index list (zigzag varints: a count, then the
// indexes; a single 0 byte means [0]). pulse reads one message type per topic, so the indexes aren't needed.
func StripConfluentHeader(b []byte) ([]byte, error) {
	if len(b) < 6 {
		return nil, errors.New("confluent: value too short")
	}
	if b[0] != 0 {
		return nil, errors.New("confluent: unknown magic byte")
	}
	rest := b[5:]
	count, n := binary.Varint(rest)
	if n <= 0 || count < 0 {
		return nil, errors.New("confluent: bad message-index count")
	}
	rest = rest[n:]
	for i := int64(0); i < count; i++ {
		if _, n = binary.Varint(rest); n <= 0 {
			return nil, errors.New("confluent: bad message index")
		}
		rest = rest[n:]
	}
	return rest, nil
}
