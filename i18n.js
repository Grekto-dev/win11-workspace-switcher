// Internationalisation helper supporting Auto, English, and Português (Brasil).
const { GLib } = imports.gi;

const STRINGS = {
    'pt-BR': {
        taskView: 'Exibição de tarefa',
        desktopN: 'Área de Trabalho %d',
        newDesktop: 'Nova área de trabalho',
        rename: 'Renomear',
        moveLeft: 'Mover para a esquerda',
        moveRight: 'Mover para a direita',
        close: 'Fechar',
        deleteKey: 'Excluir',
        shortcutLeft: 'Alt+Shift+Esquerda',
        shortcutRight: 'Alt+Shift+Direita',
        snapLeft: 'Ajustar à esquerda',
        snapRight: 'Ajustar à direita',
        moveTo: 'Mover para',
        showAllDesktops: 'Mostrar esta janela em todas as áreas de trabalho',
        onlyThisDesktop: 'Mostrar apenas nesta área de trabalho',
        noWindows: 'Nenhuma janela aberta',
        confirmClose: 'Fechar "%s" e mover suas janelas para outra área de trabalho?',
        confirmCancel: 'Cancelar',
        confirmOk: 'Fechar',
        openTaskView: 'Abrir Visão de Tarefas',
        addDesktop: 'Nova área de trabalho',
        shortcutConflictTitle: 'Conflito de atalho detectado',
        shortcutConflictBody: 'O atalho "%s" já está em uso pelo sistema (%s) e não foi aplicado.',
    },
    en: {
        taskView: 'Task View',
        desktopN: 'Desktop %d',
        newDesktop: 'New desktop',
        rename: 'Rename',
        moveLeft: 'Move left',
        moveRight: 'Move right',
        close: 'Close',
        deleteKey: 'Delete',
        shortcutLeft: 'Alt+Shift+Left',
        shortcutRight: 'Alt+Shift+Right',
        snapLeft: 'Snap left',
        snapRight: 'Snap right',
        moveTo: 'Move to',
        showAllDesktops: 'Show this window on all desktops',
        onlyThisDesktop: 'Show only on this desktop',
        noWindows: 'No open windows',
        confirmClose: 'Close "%s" and move its windows to another desktop?',
        confirmCancel: 'Cancel',
        confirmOk: 'Close',
        openTaskView: 'Open Task View',
        addDesktop: 'New desktop',
        shortcutConflictTitle: 'Shortcut conflict detected',
        shortcutConflictBody: 'The shortcut "%s" is already in use by the system (%s) and was not applied.',
    },
};

let _lang = 'en';

function detectSystemLang() {
    try {
        const langs = GLib.get_language_names();
        for (let i = 0; i < langs.length; i++) {
            const l = String(langs[i]).toLowerCase();
            if (l.startsWith('pt')) return 'pt-BR';
            if (l.startsWith('en')) return 'en';
        }
    } catch (e) { /* fallback */ }
    return 'en';
}

function setLanguage(mode) {
    if (!mode || mode === 'auto') {
        _lang = detectSystemLang();
    } else {
        _lang = STRINGS[mode] ? mode : 'en';
    }
}

function tr(key, ...args) {
    const table = STRINGS[_lang] || STRINGS.en;
    let val = table[key] !== undefined ? table[key] : (STRINGS.en[key] || key);
    for (let i = 0; i < args.length; i++) {
        if (args[i] !== undefined) {
            val = val.replace(/%[ds]/, String(args[i]));
        }
    }
    return val;
}

module.exports = { setLanguage, tr };
