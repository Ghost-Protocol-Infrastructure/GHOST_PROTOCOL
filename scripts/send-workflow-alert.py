#!/usr/bin/env python3

import os
import smtplib
import ssl
import sys
import time
from email.message import EmailMessage


def required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def parse_int(name: str, fallback: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return fallback
    try:
        parsed = int(raw, 10)
    except ValueError as error:
        raise RuntimeError(f"Invalid integer for {name}: {raw}") from error
    if parsed <= 0:
        raise RuntimeError(f"{name} must be positive.")
    return parsed


def parse_bool(name: str, fallback: bool = False) -> bool:
    raw = os.getenv(name, "").strip().lower()
    if not raw:
        return fallback
    return raw in {"1", "true", "yes", "on"}


def build_message() -> EmailMessage:
    sender = required_env("ALERT_FROM_EMAIL")
    recipient = os.getenv("ALERT_TO_EMAIL", "ghostprotocol.infra@gmail.com").strip() or "ghostprotocol.infra@gmail.com"
    subject = required_env("ALERT_SUBJECT")
    body = required_env("ALERT_BODY")

    message = EmailMessage()
    message["From"] = sender
    message["To"] = recipient
    message["Subject"] = subject
    message.set_content(body)
    return message


def send_message(message: EmailMessage) -> None:
    server_address = required_env("ALERT_SMTP_SERVER")
    server_port = parse_int("ALERT_SMTP_PORT", 587)
    username = required_env("ALERT_SMTP_USERNAME")
    password = required_env("ALERT_SMTP_PASSWORD")
    use_ssl = parse_bool("ALERT_SMTP_SECURE", False)
    context = ssl.create_default_context()

    if use_ssl:
        with smtplib.SMTP_SSL(server_address, server_port, timeout=30, context=context) as server:
            server.login(username, password)
            server.send_message(message)
        return

    with smtplib.SMTP(server_address, server_port, timeout=30) as server:
        server.ehlo()
        if server.has_extn("starttls"):
            server.starttls(context=context)
            server.ehlo()
        server.login(username, password)
        server.send_message(message)


def main() -> int:
    retry_count = parse_int("ALERT_SMTP_RETRY_COUNT", 2)
    retry_delay_seconds = parse_int("ALERT_SMTP_RETRY_DELAY_SECONDS", 3)

    try:
        message = build_message()
    except Exception as error:
        print(f"Failed to build alert email: {error}", file=sys.stderr)
        return 1

    for attempt in range(1, retry_count + 1):
        try:
            send_message(message)
            print(f"Alert email sent successfully on attempt {attempt}/{retry_count}.")
            return 0
        except Exception as error:
            if attempt >= retry_count:
                print(f"Failed to send alert email after {attempt}/{retry_count} attempts: {error}", file=sys.stderr)
                return 1

            print(
                f"Failed to send alert email on attempt {attempt}/{retry_count}: {error}; "
                f"retrying in {retry_delay_seconds}s.",
                file=sys.stderr,
            )
            time.sleep(retry_delay_seconds * attempt)

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
