import { renderToMjml } from '@faire/mjml-react/utils/renderToMjml'
import type { Express } from 'express'
import cloneDeep from 'lodash/cloneDeep.js'
import mjml2html from 'mjml'
import type { MJMLParseResults } from 'mjml-core'
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import React from 'react'

export type SendEmailThroughProvider = (props: { to: string; subject: string; html: string }) => Promise<{
  originalResponse?: any
  loggableResponse: { status: number; statusText: string; data: any }
}>
type Variables = Record<string, any>
type ReactEmailTemplateGetter<TVariables extends Variables = Variables> = (props: TVariables) => React.ReactElement
type HtmlEmailTemplateGetter<TVariables extends Variables = Variables> = (props: TVariables) => string
type EmailTemplateGetter<TVariables extends Variables = Variables> =
  | ReactEmailTemplateGetter<TVariables>
  | HtmlEmailTemplateGetter<TVariables>
type SendEmailProps<TVariables extends Variables = Variables> = {
  to: string | { email: string }
  subject?: string
  variables: TVariables
}
type SentEmailLog<TVariables extends Variables = Variables> = SendEmailProps<TVariables> & {
  to: string
  name: string
}
type SendEmail<TVariables extends Variables = Variables> = (
  props: SendEmailProps<TVariables>
) => Promise<{ ok: boolean }>
type GetHtml<TVariables extends Variables = Variables> = (props: { variables: TVariables }) => string
type GetPreviewHtml = () => string
type EmailDefinition<TVariables extends Variables = Variables> = {
  name: string
  subject: string | ((props: TVariables) => string)
  template: EmailTemplateGetter<TVariables>
  previewVariables: TVariables
  send: SendEmail<TVariables>
  getPreviewHtml: GetPreviewHtml
  getLastSentEmail: () => SentEmailLog<TVariables> | undefined
  getSentEmails: () => Array<SentEmailLog<TVariables>>
}
type CreateEmailDefinition = <TVariables extends Variables = Variables>(props: {
  name: string
  subject: string | ((props: TVariables) => string)
  template: EmailTemplateGetter<TVariables>
  previewVariables: TVariables
}) => EmailDefinition<TVariables>

export const createEmailsThings = ({
  sendEmailThroughProvider,
  logger = console,
  mock,
}: {
  sendEmailThroughProvider: SendEmailThroughProvider
  logger?: { error: (...props: any[]) => any; info: (...props: any[]) => any }
  mock?: boolean
}) => {
  const sentEmails: SentEmailLog[] = []

  const getLastSentEmail = () => {
    if (!sentEmails.length) {
      return undefined
    }
    return sentEmails[sentEmails.length - 1]
  }

  const clearSentEmails = () => {
    sentEmails.splice(0, sentEmails.length)
  }

  const getSentEmails = () => {
    return cloneDeep(sentEmails)
  }

  const createEmailDefinition: CreateEmailDefinition = ({
    name,
    subject: templateSubject,
    template,
    previewVariables,
  }) => {
    const getLastSentEmailHere = () => {
      return sentEmails.findLast((sentEmail) => sentEmail.name === name)
    }

    const getSentEmailsHere = () => {
      return sentEmails.filter((sentEmail) => sentEmail.name === name)
    }

    const getHtml: GetHtml = ({ variables }) => {
      const templateGetResult = template(variables as any)
      if (typeof templateGetResult === 'string') {
        return templateGetResult
      }
      const reactElement = templateGetResult
      const mjml2htmlResult = mjml2html(renderToMjml(reactElement), { validationLevel: 'soft' }) as MJMLParseResults
      if (mjml2htmlResult.errors.length) {
        throw new Error(`Error on email building: ${JSON.stringify(mjml2htmlResult.errors)}`)
      }
      return mjml2htmlResult.html
    }

    const getPreviewHtml: GetPreviewHtml = () => {
      return getHtml({ variables: previewVariables })
    }

    const send: SendEmail = async ({ to, variables, subject: senderSubject }) => {
      try {
        const subject =
          senderSubject || (typeof templateSubject === 'function' ? templateSubject(variables as any) : templateSubject)
        to = typeof to === 'string' ? to : to.email
        const html = getHtml({ variables })
        const result = await (async () => {
          if (!mock) {
            return await sendEmailThroughProvider({ to, subject, html })
          } else {
            sentEmails.push({ name, to, subject, variables })
            return { loggableResponse: { status: 200, statusText: 'OK', data: 'Mocked email sent' } }
          }
        })()
        logger.info({
          tag: 'email',
          message: 'Sending email',
          meta: {
            name,
            to,
            subject,
            variables,
            response: result.loggableResponse,
          },
        })
        return { ok: true }
      } catch (error) {
        logger.error({
          tag: 'email',
          error,
          meta: {
            name,
            to,
            variables,
          },
        })
        return { ok: false }
      }
    }

    return {
      name,
      subject: templateSubject,
      template,
      send,
      previewVariables,
      getHtml,
      getPreviewHtml,
      getLastSentEmail: getLastSentEmailHere as any,
      getSentEmails: getSentEmailsHere as any,
    }
  }

  const applyEmailsPreviewsToExpressApp = ({
    expressApp,
    route,
    emailsDefinitions,
  }: {
    expressApp: Express
    route: string
    emailsDefinitions: Array<EmailDefinition<any>>
  }) => {
    if (!route.includes(':name')) {
      throw new Error('Email preview route must include ":name"')
    }
    expressApp.get(route, (req: any, res: any) => {
      const emailName = req.params.name
      const emailDefinition = emailsDefinitions.find((emailDefinition) => emailDefinition.name === emailName)
      if (!emailDefinition) {
        res.status(404).send('Email not found')
        return
      }
      res.send(emailDefinition.getPreviewHtml())
    })
  }

  return {
    createEmailDefinition,
    applyEmailsPreviewsToExpressApp,
    getSentEmails,
    getLastSentEmail,
    clearSentEmails,
  }
}
