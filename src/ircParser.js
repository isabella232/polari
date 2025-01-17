export { IrcParser };

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Tp from 'gi://TelepathyGLib';

const Signals = imports.signals;

import * as AppNotifications from './appNotifications.js';
import { RoomManager } from './roomManager.js';
import * as Utils from './utils.js';

Gio._promisify(Tp.Account.prototype,
    'request_presence_async', 'request_presence_finish');
Gio._promisify(Tp.Connection.prototype,
    'dup_contact_by_id_async', 'dup_contact_by_id_finish');
Gio._promisify(Tp.Contact.prototype,
    'request_contact_info_async', 'request_contact_info_finish');

const N_ = s => s;

export const knownCommands = {
    /* commands that would be nice to support: */
    /*
    AWAY: N_("/AWAY [<message>] — sets or unsets away message"),
    LIST: N_("/LIST [<channel>] — lists stats on <channel>, or all channels on the server"),
    MODE: "/MODE <mode> <nick|channel> — ",
    NOTICE: N_("/NOTICE <nick|channel> <message> — sends notice to <nick|channel>"),
    OP: N_("/OP <nick> — gives channel operator status to <nick>"),

    */
    CLOSE: N_('/CLOSE [<channel>] [<reason>] — closes <channel>, by default the current one'),
    HELP: N_('/HELP [<command>] — displays help for <command>, or a list of available commands'),
    INVITE: N_('/INVITE <nick> [<channel>] — invites <nick> to <channel>, or the current one'),
    JOIN: N_('/JOIN <channel> — joins <channel>'),
    KICK: N_('/KICK <nick> — kicks <nick> from current channel'),
    ME: N_('/ME <action> — sends <action> to the current channel'),
    MSG: N_('/MSG <nick> [<message>] — sends a private message to <nick>'),
    NAMES: N_('/NAMES — lists users on the current channel'),
    NICK: N_('/NICK <nickname> — sets your nick to <nickname>'),
    PART: N_('/PART [<channel>] [<reason>] — leaves <channel>, by default the current one'),
    QUERY: N_('/QUERY <nick> — opens a private conversation with <nick>'),
    QUIT: N_('/QUIT [<reason>] — disconnects from the current server'),
    SAY: N_('/SAY <text> — sends <text> to the current room/contact'),
    TOPIC: N_('/TOPIC <topic> — sets the topic to <topic>, or shows the current one'),
    WHOIS: N_('/WHOIS <nick> — requests information on <nick>'),
};
const UNKNOWN_COMMAND_MESSAGE =
    N_('Unknown command — try /HELP for a list of available commands');

const IrcParser = class IrcParser {
    constructor(room) {
        this._app = Gio.Application.get_default();
        this._roomManager = RoomManager.getDefault();
        this._room = room;
    }

    _createFeedbackLabel(text) {
        return new AppNotifications.SimpleOutput(text);
    }

    _createFeedbackUsage(cmd) {
        return this._createFeedbackLabel(_('Usage: %s').format(_(knownCommands[cmd])));
    }

    _createFeedbackGrid(header, items) {
        return new AppNotifications.GridOutput(header, items);
    }

    async process(text) {
        if (!this._room || !this._room.channel || !text.length)
            return true;

        if (text[0] !== '/') {
            this._sendText(text);
            return true;
        }

        let stripCommand = txt => txt.substr(txt.indexOf(' ')).trimLeft();

        let retval = true;

        let argv = text.trimRight().substr(1).split(/ +/);
        let cmd = argv.shift().toUpperCase();
        let output = null;
        switch (cmd) {
        case 'HELP': {
            let command = argv.shift();
            if (command)
                command = command.toUpperCase();

            retval = !command || knownCommands[command];

            if (!retval) {
                output = this._createFeedbackLabel(_(UNKNOWN_COMMAND_MESSAGE));
            } else if (command) {
                output = this._createFeedbackUsage(command);
            } else {
                output = this._createFeedbackGrid(
                    _('Known commands:'), Object.keys(knownCommands));
            }
            break;
        }
        case 'INVITE': {
            let nick = argv.shift();
            if (!nick) {
                this._createFeedbackUsage(cmd);
                retval = false;
                break;
            }
            try {
                let connection = this._room.channel.connection;
                let contact = await connection.dup_contact_by_id_async(nick);
                this._room.add_member(contact);
            } catch (e) {
                logError(e, `Failed to get contact for ${nick}`);
                retval = false;
            }
            break;
        }
        case 'J':
        case 'JOIN': {
            let room = argv.shift();
            if (!room) {
                output = this._createFeedbackUsage(cmd);
                retval = false;
                break;
            }
            if (argv.length)
                log(`Excess arguments to JOIN command: ${argv}`);

            let { account } = this._room;
            let app = Gio.Application.get_default();
            let action = app.lookup_action('join-room');
            action.activate(GLib.Variant.new('(ssu)', [
                account.get_object_path(),
                room,
                Utils.getTpEventTime(),
            ]));
            break;
        }
        case 'KICK': {
            let nick = argv.shift();
            if (!nick) {
                output = this._createFeedbackUsage(cmd);
                retval = false;
                break;
            }
            try {
                let connection = this._room.channel.connection;
                let contact = await connection.dup_contact_by_id_async(nick);
                this._room.remove_member(contact);
            } catch (e) {
                logError(e, `Failed to get contact for ${nick}`);
                retval = false;
            }
            break;
        }
        case 'ME': {
            if (!argv.length) {
                output = this._createFeedbackUsage(cmd);
                retval = false;
                break;
            }
            let action = stripCommand(text);
            let type = Tp.ChannelTextMessageType.ACTION;
            let message = Tp.ClientMessage.new_text(type, action);
            this._sendMessage(message);
            break;
        }
        case 'MSG': {
            let nick = argv.shift();
            let message = argv.join(' ');
            if (!nick || !message) {
                output = this._createFeedbackUsage(cmd);
                retval = false;
                break;
            }

            let { account } = this._room;

            let app = Gio.Application.get_default();
            let action = app.lookup_action('message-user');
            action.activate(GLib.Variant.new('(sssu)', [
                account.get_object_path(),
                nick,
                message,
                Tp.USER_ACTION_TIME_NOT_USER_ACTION,
            ]));
            break;
        }
        case 'NAMES': {
            let { channel } = this._room;
            let members = channel.group_dup_members_contacts().map(m => m.alias);
            output = this._createFeedbackGrid(
                _('Users on %s:').format(channel.identifier), members);
            break;
        }
        case 'NICK': {
            let nick = argv.shift();
            if (!nick) {
                output = this._createFeedbackUsage(cmd);
                retval = false;
                break;
            }
            if (argv.length)
                log(`Excess arguments to NICK command: ${argv}`);

            this._app.setAccountNick(this._room.account, nick);
            break;
        }
        case 'PART':
        case 'CLOSE': {
            let room = null;
            let name = argv[0];
            if (name)
                room = this._roomManager.lookupRoomByName(name, this._room.account);
            if (room)
                argv.shift(); // first arg was a room name
            else
                room = this._room;

            let app = Gio.Application.get_default();
            let action = app.lookup_action('leave-room');
            let param = GLib.Variant.new('(ss)', [room.id, argv.join(' ')]);
            action.activate(param);
            break;
        }
        case 'QUERY': {
            let nick = argv.shift();
            if (!nick) {
                output = this._createFeedbackUsage(cmd);
                retval = false;
                break;
            }

            let { account } = this._room;

            let app = Gio.Application.get_default();
            let action = app.lookup_action('message-user');
            action.activate(GLib.Variant.new('(sssu)', [
                account.get_object_path(),
                nick,
                '',
                Utils.getTpEventTime(),
            ]));
            break;
        }
        case 'QUIT': {
            let presence = Tp.ConnectionPresenceType.OFFLINE;
            let message = stripCommand(text);
            try {
                await this._room.account.request_presence_async(presence, 'offline', message);
            } catch (e) {
                logError(e, 'Failed to disconnect');
                retval = false;
            }
            break;
        }
        case 'SAY': {
            if (!argv.length) {
                output = this._createFeedbackUsage(cmd);
                retval = false;
                break;
            }
            this._sendText(stripCommand(text));
            break;
        }
        case 'TOPIC': {
            if (argv.length)
                this._room.set_topic(stripCommand(text));
            else
                output = this._createFeedbackLabel(this._room.topic || _('No topic set'));
            break;
        }
        case 'WHOIS': {
            if (!argv.length) {
                output = this._createFeedbackUsage(cmd);
                retval = false;
                break;
            }

            let nick = stripCommand(text);
            const { connection } = this._room.channel;
            const user = await connection.dup_contact_by_id_async(nick, []);
            const status = await user.request_contact_info_async(null);
            output = this._createFeedbackLabel(this._formatUserInfo(status, user));
            break;
        }
        default:
            output = this._createFeedbackLabel(_(UNKNOWN_COMMAND_MESSAGE));
            retval = false;
            break;
        }

        if (output)
            this._app.commandOutputQueue.addNotification(output);
        return retval;
    }

    _formatUserInfo(status, user) {
        let fn, last;
        if (status) {
            let info = user.get_contact_info();
            for (let i = 0; i < info.length; i++) {
                if (info[i].field_name === 'fn')
                    [fn] = info[i].field_value;
                else if (info[i].field_name === 'x-idle-time')
                    [last] = info[i].field_value;
            }
        }
        return _('User: %s - Last activity: %s').format(fn ? fn : user.alias, Utils.formatTimePassed(last));
    }

    _sendText(text) {
        let type = Tp.ChannelTextMessageType.NORMAL;
        let message = Tp.ClientMessage.new_text(type, text);
        this._sendMessage(message);
    }

    async _sendMessage(message) {
        try {
            await this._room.channel.send_message_async(message, 0);
        } catch (e) {
            // TODO: propagate to user
            logError(e, 'Failed to send message');
        }
    }
};
Signals.addSignalMethods(IrcParser.prototype);
