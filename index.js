const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const puppeteer = require('puppeteer-core');  // Ya estás usando puppeteer-core
const randomUseragent = require('random-useragent');
const mysql = require('mysql2');
const db = require('./db');
const moment = require('moment');
const path = require('path');  // Importa path para ayudar a establecer la ruta

// Establece la ruta de Chrome o Chromium en tu sistema.
const executablePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';  // Cambia esta ruta según tu instalación de Chrome

const app = express();

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

let scrapingProcess = null;
let cancelScraping = false;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const ensureDbConnection = () => {
    return new Promise((resolve, reject) => {
        db.query('SELECT 1', (err) => {
            if (err) {
                console.log('Conexión perdida. Creando una nueva conexión...');
                db.end(() => {
                    resolve();
                });
            } else {
                resolve();
            }
        });
    });
};

const insertDataIntoDB = async (data) => {
    try {
        await ensureDbConnection();

        const query = `
            INSERT INTO table_settings (nombre, autor, categoria, urls, urlPrincipal, body, fecha, image, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
        `;

        const checkQuery = `
            SELECT COUNT(*) AS count FROM table_settings WHERE urls = ?
        `;

        for (const row of data) {
            try {
                // Verificar si el registro ya existe en la base de datos
                const [rows] = await db.promise().query(checkQuery, [row.urls]);

                if (rows[0].count > 0) {
                    // Si ya existe, no insertamos
                    console.log(`El registro con urls ${row.urls} ya existe.`);
                } else {
                    // Si no existe, insertamos el nuevo registro
                    const values = [
                        row.nombre,
                        row.autor,
                        row.categoria,
                        row.urls,
                        row.urlPrincipal,
                        row.body,
                        row.fecha,
                        row.image
                    ];

                    await db.promise().query(query, values); // Usamos .promise() para la consulta de inserción
                    console.log(`Registro insertado con urls: ${row.urls}`);
                }
            } catch (err) {
                console.error('Error al verificar la existencia del registro:', err);
            }
        }
    } catch (err) {
        console.error('Error al insertar datos en la base de datos en table_settings:', err);
    }
};

// Función que verifica si la categoría existe en la base de datos
const categoriaExisteEnDB = async (slug) => {
    // const categoria = await db.query('SELECT * FROM categories WHERE slug = ?', [slug]);
    const categoria = await db.promise().query('SELECT * FROM categories WHERE slug = ?', [slug]);
    
    return categoria.length > 0; // Devuelve true si existe
};

const processPage = async (page, url, siteType) => {
    console.log('Visitando página ==>', url);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    const selectors = {
        'diariosinfronteras': {
            jobSelector: '.layout-inner',
            item: '.layout-wrap',
            image: '.wp-post-image',
            nombre: '.entry-title a',
            autor: '.post-author-bd a',
            body: '.post-excerpt',
            fecha: '.post-date-bd',
            categoria: '.post-cats a'
        },
        'expreso': {
            jobSelector: '.uk-section-default',
            item: '.uk-card-simple',
            image: '.uk-link-reset img',
            nombre: '.uk-card-title',
            autor: '.uk-card-titles',
            body: '.post-excerpts',
            fecha: '.post-date-bds',
            categoria: '.uk-footer-category a'
        },
        'andes': {
            jobSelector: '.tdc_zone.tdi_80.wpb_row.td-pb-row',
            item: '.td-module-container',
            image: 'span.entry-thumb.td-thumb-css',
            nombre: '.entry-title a',
            autor: '.td-post-author-name a',
            body: '.td-excerpt',
            fecha: 'time.entry-date',
            categoria: '.td-post-category'
        },
        'exitosa': {
            jobSelector: '.contoy',
            item: '.noti-box',
            image: '.cst_img',
            nombre: '.tit a',
            autor: '.td-post-author-name a',
            body: '.td-excerpt',
            fecha: '.date',
            categoria: '.td-post-category'
        },
    };

    const { jobSelector, item, image, nombre, autor, categoria, body, fecha } = selectors[siteType];

    try {
        await page.waitForSelector(jobSelector, { waitUntil: 'networkidle2', timeout: 10000 });
    } catch (error) {
        console.log(`Error al esperar el selector en la página ${url}. Capturando estado de la página para depuración.`);
        await page.screenshot({ path: 'error_page.png' });
        return false;
    }

    // Recopila elementos de cada selector por separado
    const listaDeItems88 = await page.$$('#tdi_88 ' + item);
    const listaDeItems93 = await page.$$('#tdi_93 ' + item);
    const listaDeItems94 = await page.$$('.layout-inner ' + item);
    const listaDeItems96 = await page.$$('.uk-section-default ' + item);
    const listaDeItems97 = await page.$$('.contoy ' + item);

    // Combina ambas listas
    const listaDeItems = [...listaDeItems88, ...listaDeItems93, ...listaDeItems94, ...listaDeItems96, ...listaDeItems97];
    let pageData = [];

    let urlPrincipal = new URL(url).origin;
    if (!urlPrincipal.endsWith('/')) {
        urlPrincipal += '/';
    }

    for (const itemElement of listaDeItems) {

        if (new URL(url).origin === 'https://www.exitosanoticias.pe') {
            const imageElement = await itemElement.$(image);
            const nombreElement = await itemElement.$(nombre);
            const autorElement = await itemElement.$(autor);
            const bodyElement = await itemElement.$(body);
            const fechaElement = await itemElement.$(fecha);
            const categoriaElement = await itemElement.$(categoria);

            // Obtener la URL de la imagen
            const imageHref = await page.evaluate(el => {
                if (el) {
                    const parentLink = el.closest('a');
                    return parentLink ? parentLink.getAttribute('href') : el.getAttribute('src');
                }
                return 'N/A';
            }, imageElement);

            let getCategoria;
            let getCategory;

            // Extraer la categoría de la URL de la imagen
            if (imageHref && imageHref !== 'N/A') {
                // Usamos una expresión regular para capturar la categoría de la URL
                const categoriaMatch = imageHref.match(/exitosanoticias\.pe\/([^\/]+)/);
                if (categoriaMatch && categoriaMatch[1]) {
                    getCategoria = categoriaMatch[1];
                    getCategory = await obtenerCategoriaPorSlug(categoriaMatch[1]);
                    console.log("Categoría extraída:", getCategoria); // Debería imprimir "Categoría: exitosa-peru"
                } else {
                    console.log("No se pudo extraer la categoría de la URL de la imagen.");
                    getCategoria = 'N/A';
                }
            } else {
                getCategoria = 'N/A';
            }

            // Verificar si la categoría extraída existe en la base de datos antes de continuar
            if (await categoriaExisteEnDB(getCategoria)) {
                const getNombre = await page.evaluate(el => el ? el.innerText : 'N/A', nombreElement);
                const getAutor = await page.evaluate((el) => {
                    return el ? el.innerText.trim() : 'Diario Exitosa';
                }, autorElement);
                const getBody = await page.evaluate(el => el ? el.innerText : 'N/A', bodyElement);
                const getFecha = await page.evaluate(el => el ? el.innerText : 'N/A', fechaElement);
                const getImage = await page.evaluate(el => el ? el.getAttribute('src') : 'N/A', imageElement);
                
                pageData.push({
                    nombre: getNombre,
                    categoria: getCategory,
                    urls: imageHref,
                    urlPrincipal: urlPrincipal,
                    autor: getAutor,
                    body: getBody,
                    fecha: getFecha,
                    image: getImage
                });
            } else {
                console.log(`Categoría '${getCategoria}' no existe en la base de datos. No se registrará el artículo.`);
            }
        } else {
            const imageElement = await itemElement.$(image);
            const nombreElement = await itemElement.$(nombre);
            const autorElement = await itemElement.$(autor);
            const bodyElement = await itemElement.$(body);
            const fechaElement = await itemElement.$(fecha);
            const categoriaElement = await itemElement.$(categoria);

            const getNombre = await page.evaluate(el => el ? el.innerText : 'N/A', nombreElement);
            
            let getAutor;
            if (new URL(url).origin === 'https://losandes.com.pe') {
                getAutor = await page.evaluate((el) => {
                    return el ? el.innerText.trim() : 'Diario Los Andes';
                }, autorElement);
            } else if (new URL(url).origin === 'https://www.exitosanoticias.pe') {
                getAutor = await page.evaluate((el) => {
                    return el ? el.innerText.trim() : 'Diario Exitosa';
                }, autorElement);
            } else {
                getAutor = await page.evaluate((el, siteType) => {
                    if (!el) {
                        console.log("autorElement no encontrado para otros sitios");
                        return siteType === 'diariosinfronteras' ? 'N/A' : 'Diario Expreso';
                    }
                    return el.innerText.trim();
                }, autorElement, siteType);
            }
            
            const imageHref = await page.evaluate(el => {
                if (el) {
                    const parentLink = el.closest('a');
                    return parentLink ? parentLink.getAttribute('href') : el.getAttribute('src');
                }
                return 'N/A';
            }, imageElement);

            let getCategoria;

            if (new URL(url).origin === 'https://www.exitosanoticias.pe') {            
                // Usamos una expresión regular para capturar la categoría entre las barras "/"
                const categoria = url.match(/exitosanoticias\.pe\/([^\/?]+)/);

                let categoryName;

                if (categoria && categoria[1]) {
                    console.log("Categoría:", categoria[1]);  // Debería imprimir "Categoría: politica"
                    categoryName = await obtenerCategoriaPorSlug(categoria[1]);
                } else {
                    console.log("No se pudo extraer la categoría.");
                }

                getCategoria = categoryName ? categoryName : 'N/A';
            } else {
                getCategoria = await page.evaluate(el => el ? el.innerText : 'N/A', categoriaElement);
            }

            let getImage;
            if (new URL(url).origin === 'https://losandes.com.pe') {
                getImage = await page.evaluate((imageElement) => {
                    if (imageElement) {
                        const dataImgUrl = imageElement.getAttribute('data-img-url');
                        if (dataImgUrl) return dataImgUrl;
                
                        const backgroundImage = imageElement.getAttribute('style');
                        const urlMatch = backgroundImage ? backgroundImage.match(/url\(["']?(.+?)["']?\)/) : null;
                        return urlMatch ? urlMatch[1] : 'N/A';
                    }
                    return 'N/A';
                }, imageElement);
                
            } else {
                getImage = await page.evaluate(el => el ? el.getAttribute('src') : 'N/A', imageElement);
            }

            const getBody = await page.evaluate(el => el ? el.innerText : 'N/A', bodyElement);
            const getFecha = await page.evaluate(el => el ? el.innerText : 'N/A', fechaElement);

            pageData.push({
                nombre: getNombre,
                categoria: getCategoria,
                urls: imageHref,
                urlPrincipal: urlPrincipal,
                autor: getAutor,
                body: getBody,
                fecha: getFecha,
                image: getImage
            });
        }
    }

    await insertDataIntoDB(pageData);
    console.log(`Datos de la página ${url} insertados en la base de datos.`);

    await delay(2000);

    return !cancelScraping;
};

const insertCategoriesIntoDB = async (data) => {
    try {
        await ensureDbConnection();

        const queryCheck = `SELECT COUNT(*) AS count FROM (SELECT id FROM categories WHERE urls = ?) AS subquery`;  
        const queryInsert = `
            INSERT INTO categories (name, slug, urls, urlPrincipal, created_at, updated_at)
            VALUES (?, ?, ?, ?, NOW(), NOW())
        `;
        const queryUpdate = `
            UPDATE categories SET name = ?, slug = ?, urlPrincipal = ?, updated_at = NOW() WHERE id = ?
        `;

        const insertedUrls = new Set();

        const validUrlPattern = /^(https:\/\/(www\.expreso\.com\.pe\/categoria\/|diariosinfronteras\.com\.pe\/category\/|losandes\.com\.pe\/category\/|larepublica\.pe\/|www\.exitosanoticias\.pe\/).+)/;

        const insertPromises = data.map((row) => {
            // Excluir categorías con nombre 'INICIO' y 'BASES PUPI SIN FRONTERAS'
            if (row.name.toUpperCase() === 'INICIO' || row.name.toUpperCase() === 'BASES PUPI SIN FRONTERAS' || row.name.toUpperCase() === 'NEWSLETTERS' || row.name.toUpperCase() === 'ÚLTIMAS NOTICIAS' || row.name.toUpperCase() === 'PERÚ' || row.name === 'Chimbote' || row.name === 'Arequipa' || row.name === 'Chiclayo' || row.name === 'Cusco' || row.name === 'huancayo' || row.name === 'Huaraz' || row.name === 'Ica' || row.name === 'Iquitos' || row.name === 'Piura' || row.name === 'Puno' || row.name === 'Tacna' || row.name === 'Trujillo' || row.name === 'TELEVISIÓN' || row.name === 'Televisión' || row.name === 'RADIO' || row.name === 'Radio') {
                console.log(`La categoría ${row.name} ha sido excluida.`);
                return Promise.resolve();
            }

            // Validar si la URL cumple con el patrón
            if (!validUrlPattern.test(row.urls)) {
                console.log(`La URL ${row.urls} no cumple con el formato requerido. Se excluye.`);
                return Promise.resolve();
            }

            // Verificar si la URL ya fue procesada
            if (insertedUrls.has(row.urls)) {
                console.log(`El registro con URL ${row.urls} ya fue procesado previamente.`);
                return Promise.resolve();
            }

            insertedUrls.add(row.urls);

            const values = [row.name, row.slug, row.urls, row.urlPrincipal];

            return new Promise((resolve, reject) => {
                db.query(queryCheck, [row.urls], (err, result) => {
                    if (err) {
                        console.error('Error verificando si el registro existe:', err);
                        return reject(err);
                    }

                    if (result[0].count === 0) {
                        // Si no existe el registro, insertamos uno nuevo
                        db.query(queryInsert, values, (err) => {
                            if (err) {
                                console.error('Error insertando datos en categories:', err);
                                return reject(err);
                            } else {
                                console.log(`Categoría ${row.name} insertada.`);
                                resolve();
                            }
                        });
                    } else {
                        // Si el registro existe, actualizamos solo los campos name, slug y urlPrincipal
                        const categoryId = result[0].id;
                        db.query(queryUpdate, [row.name, row.slug, row.urlPrincipal, categoryId], (err) => {
                            if (err) {
                                console.error('Error actualizando datos en categories:', err);
                                return reject(err);
                            } else {
                                console.log(`Categoría ${row.name} actualizada.`);
                                resolve();
                            }
                        });
                    }
                });
            });
        });

        await Promise.all(insertPromises);
    } catch (err) {
        console.error('Error al insertar datos en la tabla categories:', err);
    }
};

const processPageCategory = async (page, url, siteType) => {
    console.log('Visitando página ==>', url);

    await delay(5000);  // Agrega un retraso antes de la navegación

    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }); // Aumenta el timeout
    } catch (error) {
        console.log(`No se pudieron cargar los resultados en la página ${url}. Error: ${error.message}`);
        return [];
    }

    // Definir selectores según el sitio
    const selectors = {
        'diariosinfronteras': {
            jobSelector: '.menu-cabecera-container',
            item: '.menu-item',
            nombre: 'a',
            urls: 'a'
        },
        'expreso': {
            jobSelector: 'ul#uk-slider-24.uk-grid.uk-grid-small.uk-slider-items',  // Selector para el contenedor principal
            item: 'li',                    // Cada categoría está en un <li>
            nombre: 'a',                   // El texto está dentro del <a>
            urls: 'a'                // El href está dentro del <a> y queremos obtener su valor
        },
        'andes': {
            jobSelector: '#menu-td-demo-header-menu-3',
            item: 'li',
            nombre: 'a',                   // El texto está dentro del <a>
            urls: 'a' 
        },
        'republica': {
            jobSelector: '.Header_container-header_menu-secciones__uh53q',
            item: '.Header_container-header_menu-secciones-item__3sngP',
            nombre: '.Header_container-header_menu-secciones-link__gOmTh',                   // El texto está dentro del <a>
            urls: '.Header_container-header_menu-secciones-link__gOmTh' 
        },
        'exitosa': {
            jobSelector: '.top-nav',
            item: 'li',
            nombre: 'a',                   // El texto está dentro del <a>
            urls: 'a' 
        },
    };

    const { jobSelector, item, nombre, urls } = selectors[siteType];

    // Espera a que el selector principal esté disponible o detiene si no está
    try {
        await page.waitForSelector(jobSelector, { timeout: 5000 });
    } catch (error) {
        console.log(`No se encontraron resultados en la página ${url}. Deteniendo...`);
        console.log(`No se pudieron cargar los resultados en la página ${url}. Error: ${error.message}`);
        return [];  // Retornar un array vacío si no se encuentran resultados
    }

    // Obtener todos los elementos de la lista
    const listaDeItems = await page.$$(item);
    let pageData = [];

    for (const itemElement of listaDeItems) {
        const nombreElement = await itemElement.$(nombre);
        const urlElement = await itemElement.$(urls);

        // Extraer el nombre y la URL del elemento, manejar errores en caso de que no exista el elemento
        const getName = nombreElement
            ? await page.evaluate(el => el.innerText.trim(), nombreElement)
            : 'N/A';
        const getUrl = urlElement
            ? await page.evaluate(el => el.getAttribute('href'), urlElement)
            : 'N/A';

        // Definir las variables base
        let urlCortado = '';
        let urlCompleto = '';
        let urlCortadoCompleto = '';

        // Verificar si la URL es la esperada
        if (new URL(url).origin === 'https://larepublica.pe') {
            urlCortado = new URL(url).origin;
            urlCompleto = urlCortado + getUrl; // Concatenar urlCortado con getUrl
            urlCortadoCompleto = urlCortado + '/'; // Agregar barra al final de urlCortado
        } else {
            urlCortado = new URL(url).origin;
            urlCompleto = getUrl; // En este caso, se usa getUrl directamente
            urlCortadoCompleto = urlCortado + '/'; // Concatenación con la barra
        }

        // Agregar los datos al array
        pageData.push({
            name: getName,
            slug: removeAccents(getName)
                .toLowerCase()
                .replace(/\s+/g, '-')          // Reemplazar los espacios por guiones
                .replace(/\b-y-\b|^y-| -y$/g, '-') // Remover "y" en solitario o entre guiones
                .replace(/-+/g, '-')           // Remover guiones adicionales consecutivos
                .replace(/^-|-$/g, ''),       // Eliminar guiones al inicio o al final
            urls: urlCompleto,
            urlPrincipal: urlCortadoCompleto
        });
    }

    // Insertar datos en la base de datos
    if (pageData.length > 0) {
        if (new URL(url).origin === 'https://losandes.com.pe') {
            await insertCategoriesIntoDB(pageData);
            await insertCategoriesIntoDB(data);
        } else {
            await insertCategoriesIntoDB(pageData);
        }
        
        console.log(`Datos de la página ${url} insertados en la tabla categories.`);
    } else {
        console.log(`No se encontraron categorías en la página ${url}.`);
    }

    await delay(2000);

    // Retornar el array de categorías extraídas
    return pageData;
};

function removeAccents(str) {
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

const data = [
    { name: 'DIARIO VIRTUAL', slug: 'diario-virtual', urls: 'https://losandes.com.pe/category/diario-virtual/', urlPrincipal: 'https://losandes.com.pe/' },
    { name: 'MARQUIÑO', slug: 'marquino', urls: 'https://losandes.com.pe/category/marquino/', urlPrincipal: 'https://losandes.com.pe/' },
    { name: 'LOCAL', slug: 'local', urls: 'https://losandes.com.pe/category/local/', urlPrincipal: 'https://losandes.com.pe/' },
    { name: 'ESPECIAL', slug: 'especial', urls: 'https://losandes.com.pe/category/especial/', urlPrincipal: 'https://losandes.com.pe/' },
];

// Función para obtener las categorías antes de comenzar el scraping
const getCategoriasAExcluir = async () => {
    // Aquí puedes listar explícitamente las categorías que no deseas procesar.
    return ['inicio', 'bases-pupi-sin-fronteras', 'regiones', 'television', 'radio', 'opinion', 'apec-2024', 'agustin-lozano', 'universitario', 'paro-nacional', 'dolar-en-peru', 'donald-trump', 'san-marcos', 'aumento-de-sueldo', 'christian-cueva', 'venezuela', 'mexico', 'argentina', 'estados-unidos', 'ultimas-noticias']; // Excluir la categoría 'INICIO'
};

async function obtenerCantidadVecesDesdeUser(userId) {
    try {
        // Establecer conexión a la base de datos
        await ensureDbConnection();

        // Paso 1: Obtener el membership_id del usuario
        const userQuery = `
            SELECT membership_id FROM users WHERE id = ?
        `;
        const [userRows] = await db.promise().query(userQuery, [userId]);

        // Verificar si se obtuvo el membership_id
        if (userRows.length === 0) {
            console.log('No se encontró el usuario con ese ID.');
            return null;
        }

        const membershipId = userRows[0].membership_id;

        // Paso 2: Obtener cantidad_veces desde la tabla memberships usando el membership_id
        const membershipQuery = `
            SELECT cantidad_veces FROM memberships WHERE id = ?
        `;
        const [membershipRows] = await db.promise().query(membershipQuery, [membershipId]);

        // Verificar si se obtuvo el valor de cantidad_veces
        if (membershipRows.length > 0) {
            return membershipRows[0].cantidad_veces; // Retorna el valor de cantidad_veces
        } else {
            console.log('No se encontró el registro en la tabla memberships.');
            return null;
        }
    } catch (error) {
        console.error('Error al obtener cantidad_veces desde memberships:', error);
        return null; // Maneja el error de forma adecuada
    }
}

async function obtenerCategoriasDesdeLink(linkweb) {
    try {
        // Establecer conexión a la base de datos
        await ensureDbConnection();

        // Paso 1: Obtener todas las categorías que coincidan con el urlPrincipal
        const categoryQuery = `
            SELECT * FROM categories WHERE urlPrincipal = ?
        `;
        const [categoryRows] = await db.promise().query(categoryQuery, [linkweb]);

        // Verificar si se encontraron categorías
        if (categoryRows.length > 0) {
            return categoryRows; // Retorna todas las filas encontradas
        } else {
            console.log('No se encontraron categorías en la tabla categories para el link proporcionado.');
            return []; // Retorna un array vacío si no hay coincidencias
        }
    } catch (error) {
        console.error('Error al obtener categorías desde categories:', error);
        return []; // Maneja el error de forma adecuada
    }
}

async function obtenerCategoriaPorSlug(slug) {
    try {
        // Establecer conexión a la base de datos
        await ensureDbConnection();

        // Paso 1: Obtener la categoría que coincida con el slug
        const categoryQuery = `
            SELECT name FROM categories WHERE slug = ?
        `;
        const [categoryRows] = await db.promise().query(categoryQuery, [slug]);

        // Verificar si se encontró la categoría
        if (categoryRows.length > 0) {
            return categoryRows[0].name; // Retorna el nombre de la categoría si se encuentra
        } else {
            console.log('No se encontró la categoría con el slug proporcionado.');
            return null; // Retorna null si no se encuentra la categoría
        }
    } catch (error) {
        console.error('Error al obtener categoría por slug:', error);
        return null; // Maneja el error de forma adecuada
    }
}

async function processPageArticles(page, currentUrlPage, siteType) {
    try {
        await ensureDbConnection();
        // Realizar la solicitud HTTP
        const response = await fetch(currentUrlPage);
        const data = await response.json();  // Asumimos que la respuesta es JSON

        // Comprobar si hay artículos en la respuesta
        if (data && data.articles && data.articles.data) {
            const articles = data.articles.data;

            // Crear un array para los artículos a insertar
            const insertData = [];

            // Procesar los artículos
            for (const article of articles) {
                const title = article.title;
                const date = article.date;
                const slug = article.slug;
                const imagePath = article.data.multimedia[0]?.path; // Verifica si hay multimedia

                // Obtener la URL base
                let urlPrincipal = new URL(currentUrlPage).origin;

                // Concatenar la URL completa
                const urlPath = urlPrincipal + '' + slug; // Corregido para una concatenación más limpia

                // Buscar y capturar el valor de category_slug
                let categorySlugMatch = currentUrlPage.match(/[?&]category_slug=([^&]+)/);
                let categorySlug = categorySlugMatch ? categorySlugMatch[1] : '';

                const categoryName = await obtenerCategoriaPorSlug(categorySlug);

                console.log(categoryName);

                // Formatear los datos de la consulta
                const row = {
                    nombre: title,
                    autor: 'Diario La República',
                    categoria: categoryName || 'Sin Categoría', // Categoría, si está disponible
                    urls: urlPath, // URL completa
                    urlPrincipal: urlPrincipal, // URL principal (se podría modificar según lo que necesites)
                    body: article.data.teaser || 'Sin descripción', // Teaser o cuerpo
                    fecha: date, // Fecha del artículo
                    image: imagePath || 'https://default-image-url.com' // Imagen, si está disponible
                };

                insertData.push(row);
            }

            // Insertar los artículos procesados
            for (const row of insertData) {
                try {
                    // Verificar si el registro ya existe en la base de datos
                    const checkQuery = `
                        SELECT COUNT(*) AS count FROM table_settings WHERE urls = ?
                    `;
                    const [rows] = await db.promise().query(checkQuery, [row.urls]);

                    if (rows[0].count > 0) {
                        // Si ya existe, no insertamos
                        console.log(`El registro con urls ${row.urls} ya existe.`);
                    } else {
                        // Si no existe, insertamos el nuevo registro
                        const query = `
                            INSERT INTO table_settings (nombre, autor, categoria, urls, urlPrincipal, body, fecha, image, created_at, updated_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
                        `;
                        const values = [
                            row.nombre,
                            row.autor,
                            row.categoria,
                            row.urls,
                            row.urlPrincipal,
                            row.body,
                            row.fecha,
                            row.image
                        ];

                        await db.promise().query(query, values); // Usamos .promise() para la consulta de inserción
                        console.log(`Registro insertado con urls: ${row.urls}`);
                    }
                } catch (err) {
                    console.error('Error al verificar la existencia del registro:', err);
                }
            }

        } else {
            console.log(`No se encontraron artículos en la página ${page}`);
            return false;  // No más páginas para procesar
        }

        // Verificar si hay más artículos (por ejemplo, si el número de artículos devueltos es menor que el límite)
        return data.articles.data.length === 24;  // Si hay 24 artículos, significa que hay más páginas
    } catch (error) {
        console.error('Error al procesar la página de artículos:', error);
        return false;  // En caso de error, no continuar
    }
}

app.post('/start-scraping', async (req, res) => {
    const { link_web, user_id } = req.body;

    console.log('Enlace recibido:', link_web);

    let siteType;
    if (link_web.startsWith('https://diariosinfronteras.com.pe/')) {
        siteType = 'diariosinfronteras';
    } else if (link_web.startsWith('https://www.expreso.com.pe/')) {
        siteType = 'expreso';
    } else if (link_web.startsWith('https://losandes.com.pe/')) {
        siteType = 'andes';
    } else if (link_web.startsWith('https://larepublica.pe/')) {
        siteType = 'republica';
    } else if (link_web.startsWith('https://www.exitosanoticias.pe/')) {
        siteType = 'exitosa';
    } else {
        return res.status(400).send('Link incorrecto');
    }

    if (scrapingProcess) {
        return res.status(400).send('El scraping ya está en curso.');
    }

    cancelScraping = false;
    scrapingProcess = (async () => {
        await ensureDbConnection();
        
        const browser = await puppeteer.launch({
            headless: true, // Ejecuta Puppeteer en modo sin interfaz gráfica
            ignoreHTTPSErrors: true, // Ignora errores relacionados con HTTPS
            executablePath: executablePath, // Ruta al ejecutable de Chromium o Chrome
            // args: ['--no-sandbox', '--disable-setuid-sandbox'], // Argumentos para compatibilidad
        });

        const page = await browser.newPage();
        const header = randomUseragent.getRandom((ua) => ua.browserName === 'Firefox');
        // await page.setUserAgent(header);
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1920, height: 1080 });

        // Obtener las categorías a excluir (puedes consultar la base de datos también)
        const categoriasAExcluir = await getCategoriasAExcluir();
        console.log('Categorías a excluir:', categoriasAExcluir);

        // Obtener todas las categorías disponibles
        const categorias = await processPageCategory(page, link_web, siteType);

        // Filtrar las categorías según el dominio
        if (link_web.startsWith('https://diariosinfronteras.com.pe/')) {
           
            const categoriasFiltradas = await obtenerCategoriasDesdeLink(link_web);

            console.log('Categorías a procesar:', categoriasFiltradas);
            
            const cantidadVeces = await obtenerCantidadVecesDesdeUser(user_id);
            // Recorrer las categorías filtradas (sin la categoría INICIO)
            for (const categoria of categoriasFiltradas) {
                let pageNumber = 1;
                let hasMorePages = true;

                while (hasMorePages && !cancelScraping) {
                     // Verificar si pageNumber ha alcanzado el límite cantidadVeces
                    if (pageNumber > cantidadVeces) {
                        console.log(`Se alcanzó el límite de ${cantidadVeces} páginas para la categoría ${categoria.name}.`);
                        break;
                    }

                    const currentUrl = `${link_web}category/${categoria.slug}/page/${pageNumber}/`;
                    console.log('URL actual:', currentUrl);

                    // Procesar la página de la categoría actual
                    hasMorePages = await processPage(page, currentUrl, siteType);

                    if (hasMorePages) {
                        pageNumber++;
                    } else {
                        console.log(`No se encontraron más páginas para procesar en la categoría ${categoria.name}.`);
                    }
                }
                console.log(`Terminada la categoría ${categoria.name}.`);
            }
            
        } else if (link_web.startsWith('https://losandes.com.pe/')) {
            const categoriasFiltradas = await obtenerCategoriasDesdeLink(link_web);

            console.log('Categorías a procesar:', categoriasFiltradas);
            
            const cantidadVeces = await obtenerCantidadVecesDesdeUser(user_id);
            
            for (const categoria of categoriasFiltradas) {
                let pageNumber = 1;
                let hasMorePages = true;

                while (hasMorePages && !cancelScraping) {
                    if (pageNumber > cantidadVeces) {
                        console.log(`Se alcanzó el límite de ${cantidadVeces} páginas para la categoría ${categoria.name}.`);
                        break;
                    }

                    const currentUrl = `${link_web}category/${categoria.slug}/page/${pageNumber}/`;
                    console.log('URL actual:', currentUrl);

                    hasMorePages = await processPage(page, currentUrl, siteType);

                    if (hasMorePages) {
                        pageNumber++;
                    } else {
                        console.log(`No se encontraron más páginas para procesar en la categoría ${categoria.name}.`);
                    }
                }
                console.log(`Terminada la categoría ${categoria.name}.`);
            }
        } else if (link_web.startsWith('https://www.expreso.com.pe/')) {
            const categoriasFiltradas = await obtenerCategoriasDesdeLink(link_web);

            console.log('Categorías a procesar:', categoriasFiltradas);
            
            const cantidadVeces = await obtenerCantidadVecesDesdeUser(user_id);
            
            for (const categoria of categoriasFiltradas) {
                let pageNumber = 1;
                let hasMorePages = true;

                while (hasMorePages && !cancelScraping) {
                    if (pageNumber > cantidadVeces) {
                        console.log(`Se alcanzó el límite de ${cantidadVeces} páginas para la categoría ${categoria.name}.`);
                        break;
                    }

                    const currentUrl = `${link_web}categoria/${categoria.slug}/page/${pageNumber}/`;
                    console.log('URL actual:', currentUrl);

                    hasMorePages = await processPage(page, currentUrl, siteType);

                    if (hasMorePages) {
                        pageNumber++;
                    } else {
                        console.log(`No se encontraron más páginas para procesar en la categoría ${categoria.name}.`);
                    }
                }
                console.log(`Terminada la categoría ${categoria.name}.`);
            }
        } else if (link_web.startsWith('https://larepublica.pe/')) {
            const categoriasFiltradas = await obtenerCategoriasDesdeLink(link_web);

            console.log('Categorías a procesar:', categoriasFiltradas);
            
            const cantidadVeces = await obtenerCantidadVecesDesdeUser(user_id);
            
            for (const categoria of categoriasFiltradas) {
                let pageNumber = 1;
                let hasMorePages = true;

                while (hasMorePages && !cancelScraping) {
                    if (pageNumber > cantidadVeces) {
                        console.log(`Se alcanzó el límite de ${cantidadVeces} páginas para la categoría ${categoria.name}.`);
                        break;
                    }

                    const currentUrlPage =  `${link_web}api/search/articles?category_slug=${categoria.slug}&limit=24&page=${pageNumber}&order_by=update_date&view=section`;
                    console.log('URL actual:', currentUrlPage);

                    hasMorePages = await processPageArticles(page, currentUrlPage, siteType);

                    if (hasMorePages) {
                        pageNumber++;
                    } else {
                        console.log(`No se encontraron más páginas para procesar en la categoría ${categoria.name}.`);
                    }
                }
                console.log(`Terminada la categoría ${categoria.name}.`);
            }
        } else if (link_web.startsWith('https://www.exitosanoticias.pe/')) {
            const categoriasFiltradas = await obtenerCategoriasDesdeLink(link_web);

            console.log('Categorías a procesar:', categoriasFiltradas);
            
            const cantidadVeces = await obtenerCantidadVecesDesdeUser(user_id);
            
            for (const categoria of categoriasFiltradas) {
                let pageNumber = 1;
                let hasMorePages = true;

                while (hasMorePages && !cancelScraping) {
                    if (pageNumber > cantidadVeces) {
                        console.log(`Se alcanzó el límite de ${cantidadVeces} páginas para la categoría ${categoria.name}.`);
                        break;
                    }
                    // https://www.exitosanoticias.pe/politica/?p=6
                    const currentUrlPage =  `${link_web}${categoria.slug}/?p=${pageNumber}`;
                    console.log('URL actual:', currentUrlPage);

                    hasMorePages = await processPage(page, currentUrlPage, siteType);

                    if (hasMorePages) {
                        pageNumber++;
                    } else {
                        console.log(`No se encontraron más páginas para procesar en la categoría ${categoria.name}.`);
                    }
                }
                console.log(`Terminada la categoría ${categoria.name}.`);
            }
        } else {
            return res.status(400).send('Link incorrecto');
        }

        await page.close();
        await browser.close();

        scrapingProcess = null;
        return 'Scraping completado';
    })();

    const result = await scrapingProcess;
    res.send(result);
});

app.post('/stop-scraping', (req, res) => {
    if (scrapingProcess) {
        cancelScraping = true;
        res.send('Scraping detenido');
    } else {
        res.status(400).send('No hay proceso de scraping en curso');
    }
});

app.post('/shutdown-server', (req, res) => {
    res.send('Servidor apagándose...');
    process.exit(0);
});

app.listen(3000, () => {
    console.log('Servidor escuchando en el puerto 3000');
});
