"use strict";

const botmgr    = require('node-red-viseo-bot-manager')
const helper    = require('node-red-viseo-helper');
//const msbot     = require('../../lib/msbot.js');
//const srv       = require('../../lib/server.js');
const wechat       = require('wechat'),
      WechatAPI    = require('wechat-api');

// --------------------------------------------------------------------------
//  NODE-RED
// --------------------------------------------------------------------------

module.exports = function(RED) {
    const register = function(config) {
        RED.nodes.createNode(this, config);
        var node = this;

        config.credentials = RED.nodes.getCredentials(config.token);

        start(RED, node, config);
        this.on('input', (data)  => { menu(node, data, config)  });
        //this.on('input', (data)  => { input(node, data, config)  });
        this.on('close', (done)  => { stop(node, config, done)     });
    }
    RED.nodes.registerType("wechat", register, {});
}

/*
let bot;
let BOT_CONTEXT = {}; */

let api;
let LISTENERS = {};
let WAIT_MESSAGES = 0;
let WAIT_QUEUE = [];
let THRESHOLD = 1000 * 60 * 60 * 4;

const start = (RED, node, config) => {

    // Wechat menu
    RED.httpAdmin.post("/wechatmenu/:id", function(req,res) {
        var node = RED.nodes.getNode(req.params.id);
        if (node == null) { return res.sendStatus(404); }
        try {
            node.receive();
            res.sendStatus(200);
        } catch(err) { res.sendStatus(500); }
    });

    // Bind webhook
    api = new WechatAPI(config.credentials.id, config.credentials.secret);
    RED.httpNode.use('/wechat', middleware(node, config));

    // Add listener to reply
    let listener = LISTENERS[node.id] = (srcNode, data, srcConfig) => { reply(node, data, config) };
    helper.listenEvent('reply', listener);
}

// ------------------------------------------
//  MIDDLEWARE
// ------------------------------------------

function middleware (node, config) {
    let token = config.credentials.token;
    let now = Date.now();
    return wechat (token, function(req, res, next)  {

        let data = botmgr.buildMessageFlow({ message : req.weixin }, {
            userId:     'message.FromUserName',
            convId:     'message.FromUserName',
            inputType:  'message.MsgType',
            source:     'wechat'
        })

        switch (req.weixin.MsgType) {
            case "text":
                data.payload = req.weixin.Content;
                break;
            case "image":
                data.payload = req.weixin.EventKey || "";
                data.message.attachments.push({
                    contentUrl: req.weixin.PicUrl, 
                    contentType: "image",
                    contentId: req.weixin.MediaId
                });
                break;
            case "voice":
                data.payload = req.weixin.EventKey || "";
                data.message.attachments.push({
                    contentType: "audio",
                    contentFormat: req.weixin.Format,
                    contentId: req.weixin.MediaId
                });
                break;
            case "video":
                data.payload = req.weixin.EventKey || "";
                data.message.attachments.push({
                    contentType: "video",
                    contentThumbId: req.weixin.ThumbMediaId,
                    contentId: req.weixin.MediaId
                });
                break;
            case "location":
                data.payload = req.weixin.EventKey || "";
                data.message.attachments.push({
                    contentType: "location",
                    contentLoc: {
                        label: req.weixin.Label,
                        latitude: req.weixin.Location_X,
                        longitude: req.weixin.Location_Y,
                        scale: req.weixin.Scale
                    }
                });
                break;
            case "link":
                data.payload = req.weixin.EventKey || "";
                data.message.attachments.push({
                    contentType: "link",
                    contentLink: {
                        title: req.weixin.Title,
                        description: req.weixin.Description,
                        url: req.weixin.Url
                    }
                });
                break;
            case "event":
                if (req.weixin.Event === "location_select") { res.status(200).end(); return; }
                else if (req.weixin.Event.match(/pic/)) WAIT_MESSAGES = req.weixin.SendPicsInfo.Count;
            
                data.payload = req.weixin.EventKey || "";
                let obj = { contentType: "event",
                            contentEvent: (req.weixin.ScanCodeInfo) ? req.weixin.ScanCodeInfo : {}};
                if (req.weixin.SendPicsInfo) obj.contentEvent = req.weixin.SendPicsInfo;
                data.message.attachments.push(obj);
                break;
            default:
                data.payload = "";
                break;
        }

        if (WAIT_MESSAGES === 0) {
            res.status(200).end();
            if (WAIT_QUEUE.length > 0) {
                WAIT_QUEUE.push(data);

                if (WAIT_QUEUE[0].message.Event.match(/pic/)) {
                    data = WAIT_QUEUE[0];
                    data.message.attachments = [];
                    for (let i = 1; i < WAIT_QUEUE.length; i++) {
                        data.message.attachments.push({
                            contentUrl: WAIT_QUEUE[i].message.PicUrl, 
                            contentType: "image",
                            contentId: WAIT_QUEUE[i].message.MediaId
                        });
                    }
                } else {    data = WAIT_QUEUE[1];
                            data.payload = WAIT_QUEUE[0].payload;
                }
                WAIT_QUEUE = [];
            }

            // Handle Prompt
            let convId  = helper.getByString(data, 'user.address.conversation.id', undefined)
            if (botmgr.hasDelayedCallback(convId, data.message)) return;

            if (Object.keys(data.user.profile).length === 0 && data.user.profile.constructor === Object) {
                api.getUser({openid: convId, lang:'en'}, 
                    (err, result) => { 
                        if (err) node.error(err);
                        else {
                            data.user.profile = result;
                            data.user.profile['wcmdate'] = Date.now();
                            node.send(data);
                        }
                    });
            }
            else {
                if (Date.now() - data.user.profile.wcmdate > THRESHOLD) {
                    api.getUser({openid: convId, lang:'en'}, 
                    (err, result) => { 
                        if (err) node.error(err);
                        else {
                            data.user.profile = result;
                            data.user.profile['wcmdate'] = Date.now();
                            node.send(data);
                        }
                    });
                }
                else node.send(data);
            }
        }
        else {
            res.status(200).end();
            WAIT_QUEUE.push(data);
            WAIT_MESSAGES--;
        }
    });
}

// ------------------------------------------
//  REPLY
// ------------------------------------------

const reply = (node, data, config) => {
    try {
        // Assume we send the message to the current user address
        let address = botmgr.getUserAddress(data)
        if (!address || address.carrier !== 'wechat') return false;

        // Building the message
        let message = getMessage(data.reply, address.conversation.id, node);
        if (!message) return false;

        // Write the message to the response
        //node.warn(message);

        // Trap the event in order to continue
        helper.fireAsyncCallback(data);
    } 
    catch(ex){
         console.log("ERROR:", ex);
    }
}


const stop = (node, config, done) => {
    let listener = LISTENERS[node.id]
    helper.removeListener('reply', listener)
    done();
}

const getMessage = exports.getMessage = (replies, id, node) => {
    if (!replies) return;
    let msg = {};

    if (replies.length === 1) {
        let reply = replies[0];
        let buttons = (reply.buttons !== undefined && reply.buttons.length > 0) ? true : false ;
        let pmt = reply.prompt;

        if (reply.type === "text" && !buttons) {        // Simple text
            api.sendText(id, reply.text,
                (err) => { if (err) { node.error(err);
                return false; }});
            return true;
        }
        else if (reply.type === "text" && buttons) {    // Text & quick replies
            // TO DO
        }
        else if (reply.type === "media") {              // Image
            // WARNING : pas d'URL !!! Uniquement des images du serveur.
            //process.cwd() + "/webapp/static/viseo.png"
            api.uploadMedia(reply.media, 'image', function (err, res) {
                if (err) {
                    node.warn(err);
                    return false;
                }

                api.sendImage(id, res.media_id, function (err) { 
                    if (err) { 
                        node.error(err);
                        return false; 
                    }
                });
            })
            return true; 
        }
        else if (reply.type === "card") {              // Card
            let json = {
                title : reply.title,
                description: reply.subtitle,
                url: undefined,
                picurl: reply.attach ? reply.attach : undefined
            };

            if (buttons) {
                let key = reply.buttons[0].value;
                if (key.match(/^http/ig)) json.url = key;
                else json.key = key;
            }
            
            let myArray = [];
            myArray.push(json);

            api.sendNews(id, myArray, function (err) { 
                if (err) { 
                    node.error(err);
                    return false; 
                }
            });
        }
        else return;
    }
    else {
        // TO DO
    }
 }

// ------------------------------------------
//  MENU
// ------------------------------------------

const menu = (node, data, config) => {

    let mainButtons = config.mainButtons,
        subButtons = [config.subButtons1, config.subButtons2, config.subButtons3],
        buttons = [],
        i = 1;

    for (let button of mainButtons) {
        let json = {};
        if (button.title) {

            if (button.action === "view") {
                json = {
                    "type": "view",
                    "name": button.title,
                    "url":  button.value
                }
            }
            else if (button.action === "menu") {
                json = {
                    "name": button.title,
                    "sub_button": []
                }
                for (let subButt of subButtons[i-1]) {       
                    let sub = {
                        "name": subButt.title,
                        "type": subButt.action
                    };
                    if (subButt.action === "view") sub.url = subButt.value ;
                    else sub.key = subButt.value ;
                    json.sub_button.push(sub);
                }
            }
            else {
                json = {
                    "type": button.action,
                    "name": button.title,
                    "key":  button.value
                }    
            }
            i += 1;
            buttons.push(json);
        }
    }

    // ENVOYER LES BOUTONS
    api.createMenu({ button: buttons}, function (err) { 
        if (err) {
            node.warn(buttons);
            node.error(err);
            return false; 
        }
        else {
            node.warn("Successfully sent menu.")
            return true;
        }
    });
}

const input = (node, data, config) => {
    
        if (!api) return node.send(data);
    }