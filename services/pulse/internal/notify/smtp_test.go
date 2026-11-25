package notify

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestSMTP_SendsToMailpit(t *testing.T) {
	if testing.Short() {
		t.Skip("needs Docker")
	}
	to := "friend-" + time.Now().Format("150405.000") + "@example.test"
	mailer := NewSMTP(testSMTPHost, testSMTPPort, "", "", "Kitty <kitty@example.test>", "https://kitty.example")

	if err := mailer.Send(context.Background(), to, msg); err != nil {
		t.Fatal(err)
	}

	var list struct {
		Messages []struct {
			ID      string `json:"ID"`
			Subject string `json:"Subject"`
			To      []struct{ Address string }
		} `json:"messages"`
	}
	getJSON(t, testMailpitAPI+"/api/v1/search?query=to:"+to, &list)
	if len(list.Messages) != 1 {
		t.Fatalf("messages = %+v", list.Messages)
	}
	if got := list.Messages[0].Subject; got != "Flat 4B: Sam added Groceries · your share R 150,00" {
		t.Fatalf("subject = %q", got)
	}
	var full struct{ Text string }
	getJSON(t, testMailpitAPI+"/api/v1/message/"+list.Messages[0].ID, &full)
	if !strings.Contains(full.Text, "Sam added Groceries") || !strings.Contains(full.Text, "Open Kitty: https://kitty.example/groups/g1") {
		t.Fatalf("text = %q", full.Text)
	}
}

func TestSMTP_LongSubjectIsCut(t *testing.T) {
	m := Message{Title: "Trip", Body: strings.Repeat("x", 200), Link: "kitty://groups"}
	if s := subject(m); len([]rune(s)) != 120 {
		t.Fatalf("subject has %d characters", len([]rune(s)))
	}
}

func getJSON(t *testing.T, url string, into any) {
	t.Helper()
	res, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if err := json.NewDecoder(res.Body).Decode(into); err != nil {
		t.Fatal(err)
	}
}
