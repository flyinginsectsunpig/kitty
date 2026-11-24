package notify

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"mime"
	"net"
	"net/smtp"
	"net/textproto"
	"strconv"
	"strings"
	"time"
)

// Mailer sends one email.
type Mailer interface {
	Send(ctx context.Context, to string, m Message) error
}

type smtpMailer struct {
	host, user, password, from, webURL string
	port                               int
}

// NewSMTP sends plain-text mail: implicit TLS on port 465, STARTTLS on 587, plain otherwise (Mailpit locally).
// webURL is the app's public address; a message's kitty:// link becomes a link to the same page there.
func NewSMTP(host string, port int, user, password, from, webURL string) Mailer {
	return &smtpMailer{host: host, port: port, user: user, password: password, from: from, webURL: strings.TrimRight(webURL, "/")}
}

// subject is "{Title}: {Body}", cut at 120 characters.
func subject(m Message) string {
	s := []rune(m.Title + ": " + m.Body)
	if len(s) > 120 {
		s = s[:120]
	}
	return string(s)
}

func (s *smtpMailer) webLink(link string) string {
	return s.webURL + "/" + strings.TrimPrefix(link, "kitty://")
}

func (s *smtpMailer) Send(ctx context.Context, to string, m Message) error {
	addr := net.JoinHostPort(s.host, strconv.Itoa(s.port))
	dialer := &net.Dialer{Timeout: 15 * time.Second}
	var conn net.Conn
	var err error
	if s.port == 465 {
		conn, err = tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{ServerName: s.host, MinVersion: tls.VersionTLS12})
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return fmt.Errorf("smtp: %w", err)
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	} else {
		_ = conn.SetDeadline(time.Now().Add(time.Minute))
	}
	c, err := smtp.NewClient(conn, s.host)
	if err != nil {
		conn.Close()
		return fmt.Errorf("smtp: %w", err)
	}
	defer c.Close()

	if s.port == 587 {
		if err := c.StartTLS(&tls.Config{ServerName: s.host, MinVersion: tls.VersionTLS12}); err != nil {
			return fmt.Errorf("smtp: starttls: %w", err)
		}
	}
	if s.user != "" {
		if err := c.Auth(smtp.PlainAuth("", s.user, s.password, s.host)); err != nil {
			return fmt.Errorf("smtp: auth: %w", err)
		}
	}
	fromAddr := s.from
	if i := strings.LastIndex(fromAddr, "<"); i >= 0 {
		fromAddr = strings.TrimSuffix(fromAddr[i+1:], ">")
	}
	if err := c.Mail(fromAddr); err != nil {
		return fmt.Errorf("smtp: mail from: %w", err)
	}
	if err := c.Rcpt(to); err != nil {
		return fmt.Errorf("smtp: rcpt: %w", err)
	}
	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("smtp: data: %w", err)
	}
	body := fmt.Sprintf("From: %s\r\nTo: %s\r\nSubject: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n"+
		"Content-Transfer-Encoding: 8bit\r\nDate: %s\r\n\r\n%s\r\n\r\nOpen Kitty: %s\r\n",
		s.from, to, mime.QEncoding.Encode("utf-8", subject(m)), time.Now().UTC().Format(time.RFC1123Z), m.Body, s.webLink(m.Link))
	if _, err := w.Write([]byte(body)); err != nil {
		return fmt.Errorf("smtp: write: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("smtp: send: %w", err)
	}
	return c.Quit()
}

// IsTransient reports an SMTP failure worth retrying: a 4xx reply or a network error.
func IsTransient(err error) bool {
	var tp *textproto.Error
	if errors.As(err, &tp) {
		return tp.Code >= 400 && tp.Code < 500
	}
	var ne net.Error
	return errors.As(err, &ne) || errors.Is(err, context.DeadlineExceeded)
}
