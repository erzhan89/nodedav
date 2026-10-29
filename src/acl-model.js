// RFC 3744 access-control model. Every user owns exactly their own tree, so the ACL is fixed and read-only.
import { d, c } from './ns.js';
import { el } from './xml.js';

const supported = (tag, description, ...nested) =>
  el(d('supported-privilege'), null, el(d('privilege'), null, el(tag)), el(d('description'), { 'xml:lang': 'en' }, description), nested);

export const SUPPORTED_PRIVILEGE_SET = [
  supported(d('all'), 'Any operation',
    supported(d('read'), 'Read the content and properties', supported(c('read-free-busy'), 'Query free-busy information')),
    supported(d('write'), 'Change content and properties',
      supported(d('write-properties'), 'Write properties'),
      supported(d('write-content'), 'Write content'),
      supported(d('bind'), 'Create child resources'),
      supported(d('unbind'), 'Remove child resources')),
    supported(d('read-acl'), 'Read the access control list'),
    supported(d('write-acl'), 'Change the access control list'),
    supported(d('read-current-user-privilege-set'), 'Read the current user privileges'),
    supported(d('unlock'), 'Remove locks held by others'),
    supported(c('schedule-deliver'), 'Deliver scheduling messages',
      supported(c('schedule-deliver-invite'), 'Deliver invitations'),
      supported(c('schedule-deliver-reply'), 'Deliver replies'),
      supported(c('schedule-query-freebusy'), 'Query free-busy')),
    supported(c('schedule-send'), 'Send scheduling messages',
      supported(c('schedule-send-invite'), 'Send invitations'),
      supported(c('schedule-send-reply'), 'Send replies'),
      supported(c('schedule-send-freebusy'), 'Send free-busy requests'))),
];

export const ACL_RESTRICTIONS = [el(d('grant-only')), el(d('no-invert'))];

/** The single protected ACE: privileges granted to the owner, or to everyone who is signed in for shared roots. */
export function aclFor(privileges, principalHref, shared) {
  const who = shared ? el(d('authenticated')) : el(d('href'), null, principalHref);
  return [el(d('ace'), null, el(d('principal'), null, who), el(d('grant'), null, privileges), el(d('protected')))];
}
