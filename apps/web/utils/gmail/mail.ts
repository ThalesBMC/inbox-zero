import { z } from "zod";
import { type gmail_v1 } from "googleapis";
import MailComposer from "nodemailer/lib/mail-composer";
import Mail, { Attachment } from "nodemailer/lib/mailer";
import { zodAttachment } from "@/utils/types/mail";
import { parseMessage } from "@/utils/mail";
import { MessageWithPayload } from "@/utils/types";

export const sendEmailBody = z.object({
  replyToEmail: z
    .object({
      threadId: z.string(),
      headerMessageId: z.string(), // this is different to the gmail message id and looks something like <123...abc@mail.example.com>
      references: z.string().optional(), // for threading
    })
    .optional(),
  to: z.string(),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  replyTo: z.string().optional(),
  subject: z.string(),
  messageText: z.string(),
  messageHtml: z.string().optional(),
  attachments: z.array(zodAttachment).optional(),
});
export type SendEmailBody = z.infer<typeof sendEmailBody>;
export type SendEmailResponse = Awaited<ReturnType<typeof sendEmail>>;

const encodeMessage = (message: Buffer) => {
  return Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

const createMail = async (options: Mail.Options) => {
  const mailComposer = new MailComposer(options);
  const message = await mailComposer.compile().build();
  return encodeMessage(message);
};

const createRawMailMessage = async (
  body: Omit<SendEmailBody, "attachments"> & { attachments?: Attachment[] },
) => {
  return await createMail({
    to: body.to,
    cc: body.cc,
    bcc: body.bcc,
    subject: body.subject,
    alternatives: [
      {
        contentType: "text/plain; charset=UTF-8",
        content: body.messageText,
      },
      {
        contentType: "text/html; charset=UTF-8",
        content:
          body.messageHtml || convertTextToHtmlParagraphs(body.messageText),
      },
    ],
    attachments: body.attachments,
    // https://datatracker.ietf.org/doc/html/rfc2822#appendix-A.2
    references: body.replyToEmail
      ? `${body.replyToEmail.references || ""} ${
          body.replyToEmail.headerMessageId
        }`.trim()
      : "",
    inReplyTo: body.replyToEmail ? body.replyToEmail.headerMessageId : "",
    headers: {
      "X-Mailer": "Inbox Zero Web",
    },
  });
};

// https://developers.google.com/gmail/api/guides/sending
// https://www.labnol.org/google-api-service-account-220405
export async function sendEmail(gmail: gmail_v1.Gmail, body: SendEmailBody) {
  const raw = await createRawMailMessage(body);

  const result = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      threadId: body.replyToEmail ? body.replyToEmail.threadId : undefined,
      raw,
    },
  });

  return result;
}

export async function forwardEmail(
  gmail: gmail_v1.Gmail,
  options: {
    messageId: string;
    to: string;
    cc?: string;
    bcc?: string;
    content?: string;
  },
) {
  const message = await gmail.users.messages.get({
    userId: "me",
    id: options.messageId,
  });

  const messageId = message.data.id;
  if (!messageId) throw new Error("Message not found");

  const parsedMessage = parseMessage(message.data as MessageWithPayload);

  const attachments = await Promise.all(
    parsedMessage.attachments.map(async (attachment) => {
      const attachmentData = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId,
        id: attachment.attachmentId,
      });
      return {
        content: Buffer.from(attachmentData.data.data || "", "base64"),
        contentType: attachment.mimeType,
        filename: attachment.filename,
      };
    }),
  );

  const raw = await createRawMailMessage({
    to: options.to,
    cc: options.cc,
    bcc: options.bcc,
    subject: `Fwd: ${parsedMessage.headers.subject}`,
    messageText: `${options.content ?? ""}
        
---------- Forwarded message ----------
From: ${parsedMessage.headers.from}
Date: ${parsedMessage.headers.date}
Subject: ${parsedMessage.headers.subject}
To: <${parsedMessage.headers.to}>

${parsedMessage.textPlain}`,
    messageHtml: `<div>${options.content ?? ""}</div>

<div>---------- Forwarded message ----------</div>
<div>From: ${parsedMessage.headers.from}</div>
<div>Date: ${parsedMessage.headers.date}</div>
<div>Subject: ${parsedMessage.headers.subject}</div>
<div>To: <${parsedMessage.headers.to}></div>

<br>

${parsedMessage.textHtml}`,
    replyToEmail: {
      threadId: message.data.threadId || "",
      references: "",
      headerMessageId: "",
    },
    attachments,
  });

  const result = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      threadId: message.data.threadId,
      raw,
    },
  });

  return result;
}

export async function draftEmail(gmail: gmail_v1.Gmail, body: SendEmailBody) {
  const raw = await createRawMailMessage(body);

  const result = await gmail.users.drafts.create({
    userId: "me",
    requestBody: {
      message: {
        threadId: body.replyToEmail ? body.replyToEmail.threadId : "",
        raw,
      },
    },
  });

  return result;
}

const convertTextToHtmlParagraphs = (text: string): string => {
  // Split the text into paragraphs based on newline characters
  const paragraphs = text
    .split("\n")
    .filter((paragraph) => paragraph.trim() !== "");

  // Wrap each paragraph with <p> tags and join them back together
  const htmlContent = paragraphs
    .map((paragraph) => `<p>${paragraph.trim()}</p>`)
    .join("");

  return `<html><body>${htmlContent}</body></html>`;
};
