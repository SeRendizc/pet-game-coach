export function companion(context,memory,message){
 if(/烦|输了|难受|好菜/.test(message))return {text:'可以先缓一缓，不用马上再开一局。想继续就继续，想回看我们只聊一个具体回合。',evidence:[]};
 if(/^[？?]+$|连续性|什么意思|为什么|为啥/.test(message)){const lastReply=(memory.dialogue||[]).filter(x=>x.role==='assistant').at(-1)?.content;return {text:lastReply?'你是在接着刚才那句话问。我记得我们刚聊到：'+lastReply.slice(0,90)+'。可以指出哪一点不对，我接着核对。':'这句我还没接准。你指的是哪一处？',evidence:[]};}
 const last=memory.events.at(-1);
 return {text:`我在。${last?'记得上一场是在'+last.stage+'，结果是'+({win:'胜利',loss:'失利',draw:'平局'}[last.result]||last.result)+'。':''}${memory.lessons.length?'我们已经练过速度判断了。':'想培养伙伴、分析这一回合，或随便聊一句都可以。'}`,evidence:memory.events.length?['记忆来自本机已完成的真实对战，预制场景不写入。']:[]};
}
