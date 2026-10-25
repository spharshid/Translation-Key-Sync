// A corpus of correct translations the validators must ACCEPT (no false rejections), and bad ones they must CATCH.
import { validateTranslation } from '../src/ai/validate';
import { assert, done, scenario } from './helper';

type Pair = [source: string, output: string];

const GOOD: Record<string, Pair[]> = {
	es: [
		['Save changes', 'Guardar cambios'],
		['Cancel', 'Cancelar'],
		['Total', 'Total'], // cognate, single word
		['Information', 'Información'],
		['Error', 'Error'],
		['Are you sure you want to delete this item?', '¿Está seguro de que desea eliminar este elemento?'],
		['You have {{count}} new messages', 'Tiene {{count}} mensajes nuevos'],
		['Hello {{name}}, welcome back!', '¡Hola {{name}}, bienvenido de nuevo!'],
		['Click <b>here</b> to continue', 'Haga clic <b>aquí</b> para continuar'],
		['Page {{current}} of {{total}}', 'Página {{current}} de {{total}}'],
		['Enter a valid email address', 'Introduzca una dirección de correo electrónico válida'],
		['Single Sign-On', 'Inicio de sesión único'],
		['Settings', 'Configuración'],
		['Loading...', 'Cargando...'],
		['A minimum of {{min}} characters is required', 'Se requiere un mínimo de {{min}} caracteres'],
		['Use %s items at most', 'Utilice como máximo %s elementos'],
	],
	fr: [
		['Description', 'Description'], // identical single word
		['Message', 'Message'],
		['Date of birth', 'Date de naissance'],
		['Export data', 'Exporter les données'],
		['Welcome to {{app}}', 'Bienvenue dans {{app}}'],
		['This field is required', 'Ce champ est obligatoire'],
		['Service request form', 'Formulaire de demande de service'],
		['Do you want to continue?', 'Voulez-vous continuer ?'],
	],
	de: [
		['Password', 'Passwort'],
		['Two-factor authentication', 'Zwei-Faktor-Authentifizierung'],
		['Your session has expired. Please sign in again.', 'Ihre Sitzung ist abgelaufen. Bitte melden Sie sich erneut an.'],
		['Upload a file', 'Datei hochladen'],
	],
	ta: [
		['Save changes', 'மாற்றங்களைச் சேமி'],
		['Cancel', 'ரத்து செய்'],
		['Hello {{name}}', 'வணக்கம் {{name}}'],
		['You have {{count}} new messages', 'உங்களிடம் {{count}} புதிய செய்திகள் உள்ளன'],
		['Sign in with Google', 'Google மூலம் உள்நுழைக'], // brand in Latin script inside Tamil
		['Upload a file (max {{size}} MB)', 'கோப்பைப் பதிவேற்றவும் (அதிகபட்சம் {{size}} MB)'],
		['Are you sure?', 'நிச்சயமாக உள்ளதா?'],
	],
	ar: [
		['Save changes', 'حفظ التغييرات'],
		['Hello {{name}}', 'مرحبًا {{name}}'],
		['Are you sure?', 'هل أنت متأكد؟'],
		['You have {{count}} new messages', 'لديك {{count}} رسائل جديدة'],
		['Page 1 of 10', 'الصفحة 1 من 10'],
		['Sign in with Google', 'تسجيل الدخول باستخدام Google'],
	],
	ru: [
		['Save changes', 'Сохранить изменения'],
		['Delete this item', 'Удалить этот элемент'],
		['Hello {{name}}', 'Здравствуйте, {{name}}'],
	],
	zh: [
		['Save changes', '保存更改'],
		['Are you sure you want to delete this?', '您确定要删除吗？'],
		['Hello {{name}}', '你好，{{name}}'],
		['Settings', '设置'],
	],
};

const BAD: { loc: string; src: string; out: string; why: RegExp }[] = [
	{ loc: 'es', src: 'Hello {{name}}', out: 'Hola {{nombre}}', why: /placeholders/ },
	{ loc: 'es', src: 'Click <b>here</b>', out: 'Haga clic aquí', why: /placeholders/ },
	{ loc: 'es', src: 'Use %s items', out: 'Utilice %d elementos', why: /placeholders/ },
	{ loc: 'es', src: 'Delete this item permanently', out: 'Delete this item permanently', why: /English/ },
	{ loc: 'fr', src: 'Please enter your password again', out: 'Please enter your password again now', why: /English/ },
	{ loc: 'ta', src: 'Save changes', out: 'Save changes', why: /script/ },
	{ loc: 'ta', src: 'Save changes', out: 'Guardar cambios', why: /script/ },
	{ loc: 'ar', src: 'Save changes', out: 'Guardar cambios', why: /script/ },
	{ loc: 'ru', src: 'Save changes', out: 'Save changes', why: /script/ },
	{ loc: 'zh', src: 'Save changes', out: 'Guardar cambios', why: /script/ },
	{ loc: 'es', src: 'Save', out: '', why: /empty/ },
];

(async () => {
	for (const [loc, pairs] of Object.entries(GOOD)) {
		await scenario(`correct ${loc} translations are accepted (${pairs.length})`, () => {
			const rejected = pairs
				.map(([s, o]) => ({ s, o, v: validateTranslation(s, o, loc) }))
				.filter((x) => x.v.hard.length > 0)
				.map((x) => `${x.s} -> ${x.o}: ${x.v.hard.join('; ')}`);
			assert.deepEqual(rejected, [], 'false rejections:\n' + rejected.join('\n'));
		});
	}
	await scenario('correct translations raise no avoidable soft problems either', () => {
		const noisy: string[] = [];
		for (const [loc, pairs] of Object.entries(GOOD)) {
			for (const [s, o] of pairs) {
				const v = validateTranslation(s, o, loc);
				if (v.soft.length) {
					noisy.push(`${loc}: ${s} -> ${o}: ${v.soft.join('; ')}`);
				}
			}
		}
		assert.deepEqual(noisy, [], 'soft problems on correct text (each would cost a retry):\n' + noisy.join('\n'));
	});
	await scenario('known-bad translations are caught', () => {
		for (const b of BAD) {
			const v = validateTranslation(b.src, b.out, b.loc);
			assert.ok(v.hard.some((h) => b.why.test(h)), `${b.loc}: "${b.src}" -> "${b.out}" should fail with ${b.why}, got ${JSON.stringify(v)}`);
		}
	});
	done();
})();
